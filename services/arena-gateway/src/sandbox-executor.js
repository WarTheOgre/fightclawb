/**
 * engine/sandbox-executor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tier-1 Docker sandbox execution layer.
 *
 * Responsibilities:
 *   - Spawn a gVisor container per turn with extreme resource constraints
 *   - Inject game state via stdin, read move from stdout
 *   - Hard-kill container after timeout regardless of outcome
 *   - Log all executions + resource usage
 *   - Return fallback move on any failure (fail closed)
 *
 * Usage:
 *   import { SandboxExecutor } from './sandbox-executor.js';
 *   const executor = new SandboxExecutor();
 *   await executor.init();
 *   const move = await executor.runTurn(agentId, gameState);
 *
 * Design decisions:
 *   - One container per turn (no reuse): eliminates state leakage between turns
 *   - Pre-warmed pool for low latency: containers are started but paused,
 *     unpaused on demand (saves ~200ms Docker cold start)
 *   - All Docker calls are async child_process.exec; never blocks event loop
 *   - Hard process kill (SIGKILL) on timeout, not graceful shutdown
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFile, spawn } from 'node:child_process';
import { promisify }       from 'node:util';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join }            from 'node:path';
import EventEmitter        from 'node:events';
import crypto              from 'node:crypto';

const execFileAsync = promisify(execFile);

// ── Config (override via environment) ────────────────────────────────────────

const CONFIG = {
  // Docker runtime
  runtime:          process.env.SANDBOX_RUNTIME         ?? 'runsc',
  registry:         process.env.DOCKER_REGISTRY         ?? 'localhost:5000',

  // Resource limits (strings accepted by docker run)
  memory:           process.env.SANDBOX_MEMORY          ?? '512m',
  cpus:             process.env.SANDBOX_CPUS            ?? '0.5',
  pidsLimit:        parseInt(process.env.SANDBOX_PIDS   ?? '64', 10),
  tmpfsSize:        process.env.SANDBOX_TMPFS_SIZE      ?? '64m',

  // Timeouts
  turnBudgetMs:     parseInt(process.env.TURN_BUDGET_MS  ?? '5000',  10),
  // Docker overhead budget on top of turn budget before we SIGKILL
  killGraceMs:      parseInt(process.env.KILL_GRACE_MS   ?? '1500',  10),

  // Container pool
  poolSize:         parseInt(process.env.SANDBOX_POOL    ?? '4',     10),
  poolWarmupLang:   process.env.SANDBOX_POOL_LANG        ?? 'python',

  // Storage
  agentDir:         process.env.AGENT_DIR               ?? '/var/lib/arena/agents',
  logDir:           process.env.SANDBOX_LOG_DIR         ?? '/var/log/arena/sandbox',

  // Seccomp profile (written by setup-gvisor.sh)
  seccompProfile:   process.env.SECCOMP_PROFILE         ?? '/etc/docker/seccomp-arena.json',

  // ClamAV socket
  clamavSocket:     process.env.CLAMAV_SOCKET           ?? '/var/run/clamav/clamd.ctl',
};

// ── SandboxExecutor ───────────────────────────────────────────────────────────

export class SandboxExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cfg   = { ...CONFIG, ...options };
    this._pool = [];          // pre-warmed container IDs
    this._log  = null;        // execution log write stream
    this._stats = {
      total: 0, timeouts: 0, errors: 0, fallbacks: 0, killed: 0,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    mkdirSync(this.cfg.logDir, { recursive: true });
    const logPath = join(this.cfg.logDir, `exec-${new Date().toISOString().slice(0, 10)}.ndjson`);
    this._log = createWriteStream(logPath, { flags: 'a' });

    // Verify Docker + gVisor available
    await this._checkDockerRuntime();

    // Warm the container pool
    await this._warmPool();

    // Periodic cleanup of orphaned containers
    this._cleanupInterval = setInterval(() => this._cleanOrphans(), 60_000);

    this._logEvent({ type: 'executor_init', config: this.cfg });
    return this;
  }

  async shutdown() {
    clearInterval(this._cleanupInterval);
    // Kill any pooled containers
    await Promise.allSettled(this._pool.map(id => this._killContainer(id)));
    this._pool = [];
    if (this._log) this._log.end();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Execute one turn for a Tier-1 agent.
   *
   * @param {string} agentId     - Agent UUID (used to locate image)
   * @param {object} gameState   - Full turn payload from match engine
   * @param {string} lang        - 'python' | 'node'
   * @returns {object}           - { actions, nonce, [fallback] }
   */
  async runTurn(agentId, gameState, lang = 'python') {
    this._stats.total++;
    const turnId     = crypto.randomUUID();
    const startedAt  = Date.now();
    const imageRef   = this._agentImage(agentId, lang);
    const agentMount = `${this.cfg.agentDir}/${agentId}/${lang}`;

    let containerId = null;
    let timedOut    = false;
    let exitCode    = null;

    try {
      // Spawn the container
      containerId = await this._spawnContainer(imageRef, agentMount, turnId);

      // Race: send game state → get response vs kill timer
      const move = await Promise.race([
        this._communicate(containerId, gameState),
        this._killAfter(containerId, this.cfg.turnBudgetMs).then(() => {
          timedOut = true;
          throw new Error('turn_timeout');
        }),
      ]);

      exitCode = 0;
      const elapsed = Date.now() - startedAt;
      this._logEvent({
        type: 'turn_ok', turnId, agentId, lang, elapsed,
        actions: move.actions?.length ?? 0,
      });

      return move;

    } catch (err) {
      this._stats.errors++;
      const elapsed = Date.now() - startedAt;

      if (timedOut) {
        this._stats.timeouts++;
        this._logEvent({ type: 'turn_timeout', turnId, agentId, lang, elapsed });
      } else {
        this._logEvent({ type: 'turn_error', turnId, agentId, lang, elapsed, error: err.message });
      }

      this.emit('execution_error', { agentId, turnId, error: err.message, timedOut });

      // Fail closed: return fallback move
      this._stats.fallbacks++;
      return this._fallbackMove(gameState);

    } finally {
      // Always clean up — synchronous kill, fire and forget
      if (containerId) {
        this._killContainer(containerId).catch(() => {/* already gone */});
      }
    }
  }

  getStats() { return { ...this._stats }; }

  // ── Container management ───────────────────────────────────────────────────

  /**
   * Spawn a gVisor container with all security flags applied.
   * Returns the container ID.
   */
  async _spawnContainer(imageRef, agentMount, turnId) {
    const name = `arena-agent-${turnId}`;

    const args = [
      'run',
      '--detach',
      '--rm',                          // auto-remove on exit (belt-and-suspenders)

      // Identity
      `--name=${name}`,
      '--label=arena.managed=true',
      `--label=arena.turn=${turnId}`,

      // ── gVisor runtime ──────────────────────────────────────────────────
      `--runtime=${this.cfg.runtime}`,

      // ── Network isolation ───────────────────────────────────────────────
      '--network=none',

      // ── Filesystem ──────────────────────────────────────────────────────
      '--read-only',
      `--tmpfs=/tmp:size=${this.cfg.tmpfsSize},noexec,nosuid,nodev`,
      // Mount agent code read-only at /agent/
      `--volume=${agentMount}:/agent:ro,z`,

      // ── Resource limits ─────────────────────────────────────────────────
      `--memory=${this.cfg.memory}`,
      `--memory-swap=${this.cfg.memory}`,   // disable swap (swap = memory*2 otherwise)
      `--cpus=${this.cfg.cpus}`,
      `--pids-limit=${this.cfg.pidsLimit}`,
      '--ulimit=nofile=64:64',              // max open file descriptors
      '--ulimit=nproc=32:32',               // max processes (belt+suspenders with pids-limit)
      '--ulimit=fsize=10485760',            // 10MB max file write to /tmp

      // ── Capability restrictions ──────────────────────────────────────────
      '--cap-drop=ALL',
      '--no-new-privileges',

      // ── seccomp profile ──────────────────────────────────────────────────
      `--security-opt=seccomp=${this.cfg.seccompProfile}`,
      '--security-opt=no-new-privileges:true',

      // ── Environment ─────────────────────────────────────────────────────
      `--env=TURN_BUDGET_MS=${this.cfg.turnBudgetMs}`,
      '--env=PYTHONDONTWRITEBYTECODE=1',
      '--env=PYTHONUNBUFFERED=1',

      // Keep stdin open (we pipe game state to it)
      '--interactive',

      imageRef,
    ];

    const { stdout } = await execFileAsync('docker', args, { timeout: 10_000 });
    return stdout.trim();   // container ID (full 64-char SHA)
  }

  /**
   * Write game state to container stdin, read one line from stdout.
   */
  async _communicate(containerId, gameState) {
    return new Promise((resolve, reject) => {
      // `docker attach` pipes stdin/stdout of a running container
      const proc = spawn('docker', ['attach', '--no-stdin=false', containerId], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        proc.stdin.destroy();
        fn(val);
      };

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        // We expect exactly one JSON line
        const newline = stdout.indexOf('\n');
        if (newline !== -1) {
          try {
            const move = JSON.parse(stdout.slice(0, newline));
            settle(resolve, move);
          } catch (err) {
            settle(reject, new Error(`stdout JSON parse failed: ${err.message}`));
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        // Log agent stderr to our log (capped at 4KB)
        if (stderr.length > 4096) stderr = stderr.slice(-4096);
      });

      proc.on('error', (err) => settle(reject, err));
      proc.on('close', (code) => {
        if (!settled) {
          if (stdout.trim()) {
            try {
              settle(resolve, JSON.parse(stdout.trim()));
            } catch {
              settle(reject, new Error(`container exited (${code}) with unparseable stdout`));
            }
          } else {
            settle(reject, new Error(`container exited (${code}) with no stdout`));
          }
        }
        // Always log stderr
        if (stderr.trim()) {
          this._logEvent({ type: 'agent_stderr', containerId, stderr: stderr.slice(0, 2000) });
        }
      });

      // Send game state
      proc.stdin.write(JSON.stringify(gameState) + '\n');
      // Don't end stdin yet — the container may still be starting up
    });
  }

  // ── Timeout / kill helpers ─────────────────────────────────────────────────

  _killAfter(containerId, ms) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        await this._killContainer(containerId);
        this._stats.killed++;
        resolve();
      }, ms + this.cfg.killGraceMs);
    });
  }

  async _killContainer(containerId) {
    try {
      await execFileAsync('docker', ['kill', '--signal=SIGKILL', containerId], { timeout: 5_000 });
    } catch {
      // Container may have already exited — ignore
    }
    try {
      await execFileAsync('docker', ['rm', '--force', containerId], { timeout: 5_000 });
    } catch {
      // Best effort
    }
  }

  // ── Container pool ─────────────────────────────────────────────────────────

  async _warmPool() {
    // Pre-warm pool with base images only (no agent code mounted yet)
    // This eliminates the cold-start time for Docker image pull + layer setup.
    // Containers in the pool are NOT running — they are created but paused.
    // On demand we resume the paused container, which is faster than cold start.
    //
    // For now: pool is just pre-pulled images.
    const lang    = this.cfg.poolWarmupLang;
    const baseImg = `${this.cfg.registry}/arena/sandbox-${lang}:latest`;

    try {
      await execFileAsync('docker', ['pull', '--quiet', baseImg], { timeout: 120_000 });
      this._logEvent({ type: 'pool_warmed', lang, image: baseImg });
    } catch (err) {
      this._logEvent({ type: 'pool_warm_failed', lang, error: err.message });
    }
  }

  // ── Orphan cleanup ─────────────────────────────────────────────────────────

  async _cleanOrphans() {
    try {
      // Find containers with our label that are older than 2 minutes
      const { stdout } = await execFileAsync('docker', [
        'ps', '-a',
        '--filter=label=arena.managed=true',
        '--format={{.ID}}\t{{.CreatedAt}}\t{{.Status}}',
      ], { timeout: 10_000 });

      const now = Date.now();
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const [id, createdAt] = line.split('\t');
        const age = now - new Date(createdAt).getTime();
        if (age > 120_000) {    // > 2 minutes old
          await this._killContainer(id);
          this._logEvent({ type: 'orphan_killed', containerId: id, ageMs: age });
        }
      }
    } catch {
      // Best effort — don't crash the executor
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _agentImage(agentId, lang) {
    // Custom agent images are tagged: registry/arena/agent-{agentId}:latest
    // If the custom image doesn't exist, fall back to the base sandbox image.
    // The executor doesn't check existence here — Docker will fail and we catch it.
    return `${this.cfg.registry}/arena/agent-${agentId}-${lang}:latest`;
  }

  _fallbackMove(gameState) {
    const valid = gameState?.validMoves ?? [];
    return {
      actions:  valid.length ? [valid[0]] : [],
      nonce:    gameState?.turnNonce ?? '',
      fallback: true,
    };
  }

  async _checkDockerRuntime() {
    const { stdout } = await execFileAsync('docker', ['info', '--format={{json .Runtimes}}'], {
      timeout: 10_000,
    });
    const runtimes = JSON.parse(stdout.trim());
    if (!runtimes[this.cfg.runtime]) {
      throw new Error(
        `Docker runtime '${this.cfg.runtime}' not available. ` +
        `Run scripts/setup-gvisor.sh first. Available: ${Object.keys(runtimes).join(', ')}`
      );
    }
  }

  _logEvent(obj) {
    const entry = JSON.stringify({ ts: new Date().toISOString(), ...obj });
    if (this._log?.writable) this._log.write(entry + '\n');
  }
}

// ── Singleton (for use in arena-gateway) ─────────────────────────────────────

let _executor = null;

export async function getSandboxExecutor() {
  if (!_executor) {
    _executor = new SandboxExecutor();
    await _executor.init();
  }
  return _executor;
}
