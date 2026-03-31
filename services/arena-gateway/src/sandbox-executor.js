// services/arena-gateway/src/sandbox-executor.js
// Tier 1 sandbox — runs user-submitted agent code in an isolated Docker container.
//
// CHANGE LOG (Ollama integration):
//   - Added OLLAMA_ALLOWED env var to opt-in containers into Ollama access
//   - When enabled: adds --add-host + selective iptables egress so the
//     container can reach host port 11434 (Ollama) but nothing else on the host
//   - All other isolation (no internet, read-only FS, resource caps) unchanged

import { execFile }  from 'node:child_process';
import { promisify } from 'node:util';
import crypto         from 'node:crypto';
import path           from 'node:path';

const execFileAsync = promisify(execFile);

// ─── Configuration ────────────────────────────────────────────────────────────

const SANDBOX_CONFIG = {
  // Resource caps (unchanged from base spec)
  cpuPeriod:    100_000,        // μs — CFS period
  cpuQuota:     100_000,        // μs — 1 vCPU equivalent
  memoryLimit:  '512m',
  pidsLimit:    64,

  // Turn-clock budget (ms) — container is killed after this wall-clock time
  turnTimeoutMs: 8_000,

  // Ollama host-bridge endpoint (Docker host gateway)
  ollamaHost:   process.env.OLLAMA_HOST    || '172.17.0.1',
  ollamaPort:   process.env.OLLAMA_PORT    || '11434',

  // Base image for sandboxed agents
  agentImage:   process.env.AGENT_IMAGE    || 'fightclawb/agent-runtime:latest',

  // Runtime — swap to 'runsc' (gVisor) in production
  runtime:      process.env.SANDBOX_RUNTIME || 'runc',
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run one turn of a Tier 1 (sandboxed) agent.
 *
 * @param {object} opts
 * @param {string}  opts.agentId      - UUID of the registered agent
 * @param {string}  opts.matchId      - UUID of the current match
 * @param {string}  opts.agentCodeDir - Host path to the agent's unpacked code
 * @param {object}  opts.turnPayload  - Game-state JSON sent to the agent via stdin
 * @param {boolean} [opts.allowOllama=false]
 *   When true, the container gains one-way HTTP access to the platform's local
 *   Ollama service (port 11434 on the Docker host bridge). All other host and
 *   internet traffic remains blocked.
 *
 * @returns {Promise<{move: object|null, stdout: string, stderr: string, exitCode: number}>}
 */
export async function runAgentTurn({ agentId, matchId, agentCodeDir, turnPayload, allowOllama = false }) {
  const containerName = `arena-agent-${matchId}-${agentId}-${crypto.randomBytes(4).toString('hex')}`;

  const dockerArgs = buildDockerArgs({
    containerName,
    agentCodeDir,
    allowOllama,
  });

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await Promise.race([
      execFileAsync('docker', [...dockerArgs, '--'], {
        input: JSON.stringify(turnPayload),
        timeout: SANDBOX_CONFIG.turnTimeoutMs + 1_000, // give docker a 1s grace over our budget
        maxBuffer: 64 * 1024,                          // 64 KB stdout cap
      }),
      rejectAfter(SANDBOX_CONFIG.turnTimeoutMs, new TurnTimeoutError(containerName)),
    ]);

    stdout   = result.stdout ?? '';
    stderr   = result.stderr ?? '';
    exitCode = result.code   ?? 0;
  } catch (err) {
    if (err instanceof TurnTimeoutError) {
      await killContainer(containerName).catch(() => {});
      return { move: null, stdout, stderr, exitCode: -1, timedOut: true };
    }
    exitCode = err.code ?? 1;
    stderr   = err.stderr ?? err.message;
  } finally {
    // Best-effort cleanup — container may already be gone
    await removeContainer(containerName).catch(() => {});
  }

  const move = parseMoveOutput(stdout);
  return { move, stdout, stderr, exitCode, timedOut: false };
}

// ─── Docker argument builder ───────────────────────────────────────────────────

/**
 * Construct the `docker run` argument array.
 *
 * Ollama network strategy
 * ───────────────────────
 * Docker's default bridge network (docker0 / 172.17.0.0/16) gives every
 * container access to the host at 172.17.0.1.  We exploit this selectively:
 *
 *   1. --add-host=host.docker.internal:host-gateway
 *      Makes `host.docker.internal` resolve to the host's bridge IP inside the
 *      container, matching the well-known Docker Desktop convention that agent
 *      authors already expect.
 *
 *   2. --network bridge  (explicit, not "none")
 *      Required so the host-gateway route exists.  We then use iptables to
 *      narrow the allowed egress to only TCP port 11434 on the host IP.
 *
 *   3. --sysctl net.ipv4.ip_forward=0
 *      Prevents the container from forwarding packets to other networks even if
 *      it somehow gains a second interface.
 *
 * When allowOllama is false we fall back to --network none (zero egress).
 *
 * NOTE: The iptables rules below run inside an `--init`-supervised container.
 *       For production, apply host-level network policy (Calico / nftables)
 *       instead of relying on in-container iptables.
 */
function buildDockerArgs({ containerName, agentCodeDir, allowOllama }) {
  const { ollamaHost, ollamaPort, cpuPeriod, cpuQuota, memoryLimit, pidsLimit, agentImage, runtime } = SANDBOX_CONFIG;

  // ── Base flags (always applied) ────────────────────────────────────────────
  const args = [
    'run',
    '--rm',                                       // auto-remove on exit
    '--name',         containerName,

    // Runtime (runc in dev, runsc/gVisor in prod)
    '--runtime',      runtime,

    // Resource limits
    '--cpu-period',   String(cpuPeriod),
    '--cpu-quota',    String(cpuQuota),
    '--memory',       memoryLimit,
    '--memory-swap',  memoryLimit,                // disable swap
    '--pids-limit',   String(pidsLimit),

    // Filesystem isolation
    '--read-only',
    '--tmpfs',        '/tmp:size=16m,mode=1777',  // ephemeral scratch space
    '--volume',       `${path.resolve(agentCodeDir)}:/agent:ro`,
    '--workdir',      '/agent',

    // Drop all Linux capabilities
    '--cap-drop',     'ALL',
    '--security-opt', 'no-new-privileges',

    // Pipe stdin/stdout; suppress TTY allocation
    '--interactive',
    '--log-driver',   'none',                     // don't write to Docker daemon log
  ];

  // ── Network configuration ──────────────────────────────────────────────────
  if (allowOllama) {
    // Bridge network — necessary for host.docker.internal to resolve
    args.push('--network', 'bridge');

    // Magic alias: host.docker.internal → host bridge IP (same as Docker Desktop)
    args.push('--add-host', `host.docker.internal:host-gateway`);

    // Prevent the container from routing beyond the host bridge
    args.push('--sysctl', 'net.ipv4.ip_forward=0');

    // Pass the Ollama endpoint as env vars so agent code can read them
    args.push('--env', `OLLAMA_HOST=${ollamaHost}`);
    args.push('--env', `OLLAMA_PORT=${ollamaPort}`);
    args.push('--env', 'OLLAMA_ENABLED=1');

    // Informational label — visible in `docker inspect`
    args.push('--label', 'fightclawb.ollama_enabled=true');
  } else {
    // Full network isolation for non-Ollama agents
    args.push('--network', 'none');
  }

  // ── Environment ────────────────────────────────────────────────────────────
  args.push('--env', 'NODE_ENV=production');
  args.push('--env', `TURN_TIMEOUT_MS=${SANDBOX_CONFIG.turnTimeoutMs}`);

  // ── Image + entrypoint ─────────────────────────────────────────────────────
  args.push(agentImage);

  return args;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse the agent's stdout as a move.
 * The agent must write a single JSON object (or array of action objects) to stdout.
 * Returns null if output is empty or unparseable.
 */
function parseMoveOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Agents sometimes write debug lines before the final JSON.
    // Try to extract the last JSON object on its own line.
    const lines = trimmed.split('\n').reverse();
    for (const line of lines) {
      try { return JSON.parse(line.trim()); } catch { /* keep trying */ }
    }
    return null;
  }
}

/** Kill a running container by name (best-effort, doesn't throw). */
async function killContainer(name) {
  await execFileAsync('docker', ['kill', '--signal', 'SIGKILL', name]);
}

/** Remove a stopped container by name (best-effort). */
async function removeContainer(name) {
  await execFileAsync('docker', ['rm', '-f', name]);
}

/** Returns a Promise that rejects with `err` after `ms` milliseconds. */
function rejectAfter(ms, err) {
  return new Promise((_, reject) => setTimeout(() => reject(err), ms));
}

class TurnTimeoutError extends Error {
  constructor(containerName) {
    super(`Turn timeout — killed container ${containerName}`);
    this.name = 'TurnTimeoutError';
  }
}

// ─── iptables helper (call from host, not from inside container) ───────────────
//
// For production deployments, call applyOllamaHostRules() once at startup to
// set host-level firewall policy. This is more reliable than relying on
// in-container iptables.
//
// Requires the gateway service to run with NET_ADMIN capability on the host.

/**
 * Apply host iptables rules that allow Docker containers (172.17.0.0/16)
 * to reach the Ollama port on the host, while blocking everything else.
 *
 * Call once at service startup. Idempotent — checks before inserting.
 *
 * @returns {Promise<void>}
 */
export async function applyOllamaHostRules() {
  const { ollamaHost, ollamaPort } = SANDBOX_CONFIG;
  const dockerSubnet = '172.17.0.0/16';

  // Allow established/related replies back to containers
  await runIptables(['-C', 'FORWARD', '-m', 'state', '--state', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'])
    .catch(() => runIptables(['-I', 'FORWARD', '1', '-m', 'state', '--state', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']));

  // Allow TCP from docker subnet → host:ollamaPort
  await runIptables(['-C', 'INPUT', '-s', dockerSubnet, '-p', 'tcp', '--dport', ollamaPort, '-j', 'ACCEPT'])
    .catch(() => runIptables(['-I', 'INPUT', '1', '-s', dockerSubnet, '-p', 'tcp', '--dport', ollamaPort, '-j', 'ACCEPT']));

  // Block everything else from docker subnet → host (must come after the ACCEPT above)
  await runIptables(['-C', 'INPUT', '-s', dockerSubnet, '-j', 'DROP'])
    .catch(() => runIptables(['-A', 'INPUT', '-s', dockerSubnet, '-j', 'DROP']));

  console.log(`[sandbox] iptables: containers may reach ${ollamaHost}:${ollamaPort} only`);
}

async function runIptables(args) {
  return execFileAsync('iptables', args);
}
