#!/usr/bin/env node
// /harness.mjs — Arena Tier-1 Node.js sandbox harness
// Baked into the base image. Never replaced by agent code.
// Mirrors the Python harness contract exactly.

import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import path from 'node:path';

const AGENT_FILE   = '/agent/agent.mjs';
const TURN_BUDGET  = parseInt(process.env.TURN_BUDGET_MS ?? '4500', 10);

// ── Fallback ──────────────────────────────────────────────────────────────────
function fallbackMove(gameState) {
  const valid = gameState?.validMoves ?? [];
  return {
    actions:  valid.length ? [valid[0]] : [],
    nonce:    gameState?.turnNonce ?? '',
    fallback: true,
  };
}

// ── Blocked module list (Node built-ins that give network/FS/exec access) ────
const BLOCKED_MODULES = new Set([
  'child_process', 'cluster', 'dgram', 'dns', 'http', 'http2', 'https',
  'net', 'readline', 'repl', 'tls', 'tty', 'vm', 'worker_threads',
  'inspector', 'module', 'perf_hooks', 'trace_events', 'v8',
  'node:child_process', 'node:cluster', 'node:dgram', 'node:dns',
  'node:http', 'node:http2', 'node:https', 'node:net', 'node:tls',
  'node:worker_threads', 'node:vm', 'node:inspector',
]);

// Proxy around import() that blocks dangerous modules
async function safeImport(specifier) {
  const bare = specifier.replace(/^node:/, '');
  if (BLOCKED_MODULES.has(specifier) || BLOCKED_MODULES.has(bare)) {
    throw new Error(`Module blocked by Arena sandbox: ${specifier}`);
  }
  return import(specifier);
}

// ── Load agent module ─────────────────────────────────────────────────────────
async function loadAgent() {
  if (!existsSync(AGENT_FILE)) {
    throw new Error(`Agent file not found: ${AGENT_FILE}`);
  }
  // We use vm.Module for isolation — the agent's import() calls go through
  // our safeImport proxy which blocks dangerous built-ins.
  const code = readFileSync(AGENT_FILE, 'utf8');
  const ctx = vm.createContext({
    console: {
      log:   (...a) => process.stderr.write(a.join(' ') + '\n'),
      error: (...a) => process.stderr.write(a.join(' ') + '\n'),
      warn:  (...a) => process.stderr.write(a.join(' ') + '\n'),
    },
    // JSON is safe to expose
    JSON,
    Math,
    Date,
    Error,
    setTimeout: undefined,   // no async scheduling
    setInterval: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    fetch: undefined,        // definitely no fetch
    XMLHttpRequest: undefined,
  });

  const mod = new vm.SourceTextModule(code, {
    context: ctx,
    identifier: 'agent.mjs',
  });

  await mod.link(async (specifier) => {
    const bare = specifier.replace(/^node:/, '');
    if (BLOCKED_MODULES.has(specifier) || BLOCKED_MODULES.has(bare)) {
      throw new Error(`Module blocked by Arena sandbox: ${specifier}`);
    }
    // Only allow importing from /node_modules (pre-approved list)
    const resolved = await import(specifier);
    return new vm.SyntheticModule(
      Object.keys(resolved),
      function () {
        for (const [k, v] of Object.entries(resolved)) {
          this.setExport(k, v);
        }
      },
      { context: ctx }
    );
  });

  await mod.evaluate({ timeout: TURN_BUDGET });
  return mod.namespace;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Read one line from stdin
  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.once('line', (line) => { rl.close(); resolve(line); });
      rl.once('error', reject);
      rl.once('close', () => reject(new Error('stdin closed before data')));
    });
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err), actions: [] }) + '\n');
    process.exit(1);
  }

  let gameState;
  try {
    gameState = JSON.parse(raw);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: 'JSON parse failed', actions: [] }) + '\n');
    process.exit(1);
  }

  // 2. Load agent
  let agentNs;
  try {
    agentNs = await loadAgent();
  } catch (err) {
    process.stderr.write(`[harness] agent load error: ${err}\n`);
    process.stdout.write(JSON.stringify(fallbackMove(gameState)) + '\n');
    process.exit(0);
  }

  if (typeof agentNs.strategy !== 'function') {
    process.stderr.write('[harness] agent.mjs has no exported strategy() function\n');
    process.stdout.write(JSON.stringify(fallbackMove(gameState)) + '\n');
    process.exit(0);
  }

  // 3. Call strategy() with timeout
  let result;
  const timeout = setTimeout(() => {
    process.stderr.write('[harness] strategy() timed out\n');
    process.stdout.write(JSON.stringify(fallbackMove(gameState)) + '\n');
    process.exit(0);
  }, TURN_BUDGET);

  try {
    result = await agentNs.strategy(gameState);
    clearTimeout(timeout);
  } catch (err) {
    clearTimeout(timeout);
    process.stderr.write(`[harness] strategy() raised: ${err}\n`);
    process.stdout.write(JSON.stringify(fallbackMove(gameState)) + '\n');
    process.exit(0);
  }

  // 4. Validate and emit
  try {
    let actions;
    if (Array.isArray(result)) {
      actions = result;
    } else if (result && Array.isArray(result.actions)) {
      actions = result.actions;
    } else {
      throw new Error(`strategy() returned unexpected type: ${typeof result}`);
    }

    if (!actions.every(a => a && typeof a === 'object')) {
      throw new Error('each action must be an object');
    }

    const output = { actions, nonce: gameState.turnNonce ?? '' };
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (err) {
    process.stderr.write(`[harness] result validation failed: ${err}\n`);
    process.stdout.write(JSON.stringify(fallbackMove(gameState)) + '\n');
    process.exit(0);
  }
}

main().catch((err) => {
  process.stderr.write(`[harness] fatal: ${err}\n`);
  process.exit(1);
});
