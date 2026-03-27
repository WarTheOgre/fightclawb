/**
 * middleware/metrics.js — Prometheus metrics instrumentation
 *
 * Covers all five metric categories from the monitoring spec:
 *   1. Service Health  (HTTP latency, error rates, uptime)
 *   2. Game Metrics    (matches, queue, timeouts, round timing)
 *   3. Database        (PG pool, query latency, Redis hit/miss)
 *   4. Sandbox         (container spawn, resource usage, timeouts)
 *   5. Business        (registrations, active agents, retention)
 *
 * Usage:
 *   import { metricsMiddleware, gameMetrics, dbMetrics, registerRoute }
 *     from './middleware/metrics.js';
 *
 *   app.use(metricsMiddleware);          // HTTP instrumentation
 *   app.get('/metrics', registerRoute);  // Prometheus scrape endpoint
 *
 * For match engine hooks, import { gameMetrics } and call the helpers
 * at the relevant lifecycle points (see bottom of file for examples).
 */

import client from 'prom-client';

// ── Registry ─────────────────────────────────────────────────────────────────

// Use a dedicated registry so tests can reset it cleanly
const registry = new client.Registry();

// Add default Node.js / process metrics (heap, GC, event loop lag, etc.)
client.collectDefaultMetrics({
  register: registry,
  prefix:   'arena_node_',
  labels:   { service: 'arena-gateway' },
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. SERVICE HEALTH METRICS
// ─────────────────────────────────────────────────────────────────────────────

/** Total HTTP requests broken down by method, route, and status class */
export const httpRequestsTotal = new client.Counter({
  name:       'arena_http_requests_total',
  help:       'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers:  [registry],
});

/** HTTP request duration histogram — use p50 / p95 / p99 in Grafana */
export const httpRequestDuration = new client.Histogram({
  name:       'arena_http_request_duration_seconds',
  help:       'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers:  [registry],
});

/** Current number of live WebSocket connections */
export const wsConnectionsActive = new client.Gauge({
  name:      'arena_ws_connections_active',
  help:      'Currently active WebSocket connections',
  labelNames: ['role'],  // 'agent' | 'spectator'
  registers: [registry],
});

/** WebSocket messages broken down by direction and type */
export const wsMessagesTotal = new client.Counter({
  name:       'arena_ws_messages_total',
  help:       'Total WebSocket messages sent/received',
  labelNames: ['direction', 'type'],  // direction: 'inbound' | 'outbound'
  registers:  [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GAME METRICS
// ─────────────────────────────────────────────────────────────────────────────

/** Completed matches — track mode, tier, and how it ended */
export const matchesTotal = new client.Counter({
  name:       'arena_matches_total',
  help:       'Total matches completed',
  labelNames: ['mode', 'tier', 'outcome'],  // outcome: 'territory'|'home_capture'|'forfeit'|'draw'
  registers:  [registry],
});

/** Match duration from ready-signal to settlement */
export const matchDurationSeconds = new client.Histogram({
  name:       'arena_match_duration_seconds',
  help:       'Match duration in seconds (lobby-start to settlement)',
  labelNames: ['mode', 'tier'],
  buckets:    [30, 60, 120, 300, 600, 900, 1800, 3600],
  registers:  [registry],
});

/** Current agents waiting in matchmaking queue, per tier+mode */
export const queueSize = new client.Gauge({
  name:       'arena_queue_size',
  help:       'Number of agents currently in the matchmaking queue',
  labelNames: ['tier', 'mode'],
  registers:  [registry],
});

/** Time agents spend waiting from queue-join to match-start */
export const queueWaitSeconds = new client.Histogram({
  name:       'arena_queue_wait_seconds',
  help:       'Time agents wait in queue before a match is formed',
  labelNames: ['tier', 'mode'],
  buckets:    [5, 15, 30, 60, 120, 300, 600],
  registers:  [registry],
});

/** Agent turn timeouts — warnings and forfeits separately */
export const agentTimeoutsTotal = new client.Counter({
  name:       'arena_agent_timeouts_total',
  help:       'Agent turn timeouts by severity',
  labelNames: ['tier', 'severity'],  // severity: 'warning' | 'forfeit'
  registers:  [registry],
});

/** Time taken for the engine to resolve a round (apply all moves) */
export const roundResolutionSeconds = new client.Histogram({
  name:       'arena_round_resolution_seconds',
  help:       'Time for the match engine to resolve one round',
  labelNames: ['mode'],
  buckets:    [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers:  [registry],
});

/** Matches currently in lobby or active state */
export const activeMatches = new client.Gauge({
  name:       'arena_active_matches',
  help:       'Matches currently in lobby or active state',
  labelNames: ['status'],  // 'lobby' | 'active'
  registers:  [registry],
});

/** Move validation failures (illegal move attempts) */
export const illegalMovesTotal = new client.Counter({
  name:       'arena_illegal_moves_total',
  help:       'Move submissions rejected as illegal',
  labelNames: ['tier', 'reason'],
  registers:  [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DATABASE METRICS
// ─────────────────────────────────────────────────────────────────────────────

/** PG connection pool stats — set these on each pool event */
export const pgPoolConnections = new client.Gauge({
  name:       'arena_pg_pool_connections',
  help:       'PostgreSQL connection pool status',
  labelNames: ['state'],  // 'total' | 'idle' | 'waiting'
  registers:  [registry],
});

/** PG query latency by query type / table */
export const pgQueryDuration = new client.Histogram({
  name:       'arena_pg_query_duration_seconds',
  help:       'PostgreSQL query execution time',
  labelNames: ['operation', 'table'],  // operation: 'select'|'insert'|'update'|'delete'|'function'
  buckets:    [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers:  [registry],
});

/** Redis operations with cache hit/miss tracking */
export const redisOperationsTotal = new client.Counter({
  name:       'arena_redis_operations_total',
  help:       'Redis operations by command and result',
  labelNames: ['command', 'result'],  // result: 'hit' | 'miss' | 'error'
  registers:  [registry],
});

/** Redis operation latency */
export const redisOperationDuration = new client.Histogram({
  name:       'arena_redis_operation_duration_seconds',
  help:       'Redis command execution time',
  labelNames: ['command'],
  buckets:    [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05],
  registers:  [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SANDBOX METRICS
// ─────────────────────────────────────────────────────────────────────────────

/** Time from job-created to container actually running */
export const sandboxSpawnSeconds = new client.Histogram({
  name:    'arena_sandbox_spawn_seconds',
  help:    'Time to spawn a Tier 1 sandbox container',
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10],
  registers: [registry],
});

/** Sandbox job outcomes */
export const sandboxJobsTotal = new client.Counter({
  name:       'arena_sandbox_jobs_total',
  help:       'Sandbox (Tier 1) container job completions',
  labelNames: ['status'],  // 'done' | 'error' | 'killed' | 'timeout'
  registers:  [registry],
});

/** CPU usage per sandboxed agent (sampled gauge, % 0-100) */
export const sandboxCpuUsage = new client.Gauge({
  name:       'arena_sandbox_cpu_usage_percent',
  help:       'CPU usage of active sandbox containers (sampled)',
  labelNames: ['match_id'],
  registers:  [registry],
});

/** Memory usage per sandboxed agent in bytes */
export const sandboxMemoryBytes = new client.Gauge({
  name:       'arena_sandbox_memory_bytes',
  help:       'Memory usage of active sandbox containers',
  labelNames: ['match_id'],
  registers:  [registry],
});

/** Currently running sandbox containers */
export const sandboxContainersActive = new client.Gauge({
  name:    'arena_sandbox_containers_active',
  help:    'Number of sandbox containers currently running',
  registers: [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. BUSINESS METRICS
// ─────────────────────────────────────────────────────────────────────────────

/** Total agents registered on the platform (ever) */
export const agentsRegisteredTotal = new client.Counter({
  name:       'arena_agents_registered_total',
  help:       'Total agent registrations (all-time, monotonic)',
  labelNames: ['tier'],  // declared tier at registration
  registers:  [registry],
});

/** Snapshot of distinct agents that have been active in the last N hours.
 *  Set this from a scheduled job — not per-request. */
export const activeAgents = new client.Gauge({
  name:       'arena_active_agents',
  help:       'Distinct agents that played at least one match in the window',
  labelNames: ['window'],  // '24h' | '7d' | '30d'
  registers:  [registry],
});

/** Elo tier distribution snapshot — set periodically */
export const agentsByTier = new client.Gauge({
  name:       'arena_agents_by_tier',
  help:       'Number of agents in each Elo tier',
  labelNames: ['tier'],  // RECRUIT | SOLDIER | VETERAN | ELITE | CHAMPION | APEX
  registers:  [registry],
});

/** Credit consumption events */
export const creditsConsumedTotal = new client.Counter({
  name:       'arena_credits_consumed_total',
  help:       'Arena credits consumed on match entry',
  labelNames: ['mode'],
  registers:  [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express middleware — instruments every HTTP request.
 * Normalises dynamic path segments (e.g. /matches/abc-123 → /matches/:id)
 * so Prometheus labels don't explode with cardinality.
 */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs  = Number(process.hrtime.bigint() - start) / 1e9;
    const route       = normaliseRoute(req.route?.path ?? req.path);
    const statusCode  = String(res.statusCode);
    const labels      = { method: req.method, route, status_code: statusCode };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationMs);
  });

  next();
}

/**
 * Route handler that exposes /metrics in Prometheus text format.
 * Mount with:  app.get('/metrics', registerRoute);
 *
 * In production, gate this behind IP allowlist or basic auth.
 */
export async function registerRoute(_req, res) {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    res.status(500).end(String(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call from ws/handler.js when a connection opens.
 * @param {'agent'|'spectator'} role
 */
export function wsConnect(role = 'agent') {
  wsConnectionsActive.inc({ role });
}

/**
 * Call from ws/handler.js when a connection closes.
 */
export function wsDisconnect(role = 'agent') {
  wsConnectionsActive.dec({ role });
}

/**
 * Call whenever a WS message is sent or received.
 * @param {'inbound'|'outbound'} direction
 * @param {string} type  e.g. 'move', 'round_start', 'round_resolved'
 */
export function wsMessage(direction, type) {
  wsMessagesTotal.inc({ direction, type });
}

// ─────────────────────────────────────────────────────────────────────────────
// GAME ENGINE HELPERS — import into match-manager and matchmaker
// ─────────────────────────────────────────────────────────────────────────────

export const gameMetrics = {
  /** Call when a match moves from lobby → active */
  matchStarted(mode, tier) {
    activeMatches.inc({ status: 'active' });
    activeMatches.dec({ status: 'lobby' });
  },

  /** Call when a match enters the lobby (all slots filled) */
  matchLobby() {
    activeMatches.inc({ status: 'lobby' });
  },

  /**
   * Call at match settlement.
   * @param {object} opts
   * @param {string} opts.mode        '1v1' | 'ffa-3' | 'ffa-4'
   * @param {number} opts.tier        1 | 2
   * @param {string} opts.outcome     'territory' | 'home_capture' | 'forfeit' | 'draw'
   * @param {number} opts.durationSec seconds from match start to finish
   */
  matchEnded({ mode, tier, outcome, durationSec }) {
    matchesTotal.inc({ mode, tier: String(tier), outcome });
    matchDurationSeconds.observe({ mode, tier: String(tier) }, durationSec);
    activeMatches.dec({ status: 'active' });
  },

  /** Set queue depth (call from matchmaker on each tick) */
  setQueueSize(tier, mode, size) {
    queueSize.set({ tier: String(tier), mode }, size);
  },

  /** Call when an agent leaves the queue and a match has been formed */
  queueWait(tier, mode, waitSec) {
    queueWaitSeconds.observe({ tier: String(tier), mode }, waitSec);
  },

  /** Call from match engine on turn timeout */
  timeout(tier, severity) {
    agentTimeoutsTotal.inc({ tier: String(tier), severity });
  },

  /** Wrap round resolution logic to auto-time it */
  async timedRoundResolution(mode, fn) {
    const end = roundResolutionSeconds.startTimer({ mode });
    try { return await fn(); } finally { end(); }
  },

  illegalMove(tier, reason) {
    illegalMovesTotal.inc({ tier: String(tier), reason });
  },

  creditConsumed(mode) {
    creditsConsumedTotal.inc({ mode });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE HELPERS — wrap PG pool and Redis client
// ─────────────────────────────────────────────────────────────────────────────

export const dbMetrics = {
  /**
   * Call this in your PG pool 'connect', 'remove', 'acquire' event handlers.
   * @param {number} total   pool.totalCount
   * @param {number} idle    pool.idleCount
   * @param {number} waiting pool.waitingCount
   */
  updatePgPool(total, idle, waiting) {
    pgPoolConnections.set({ state: 'total' },   total);
    pgPoolConnections.set({ state: 'idle' },    idle);
    pgPoolConnections.set({ state: 'waiting' }, waiting);
  },

  /**
   * Wrap a PG query call and record latency.
   * @param {string}   operation  'select'|'insert'|'update'|'delete'|'function'
   * @param {string}   table      target table name (or function name)
   * @param {Function} fn         async function that runs the query
   */
  async timedQuery(operation, table, fn) {
    const end = pgQueryDuration.startTimer({ operation, table });
    try { return await fn(); } finally { end(); }
  },

  /**
   * Record a Redis operation result.
   * @param {string}  command  e.g. 'GET', 'SET', 'ZADD'
   * @param {boolean} hit      true if cache hit (GET returned a value)
   */
  redisResult(command, hit) {
    const result = hit ? 'hit' : 'miss';
    redisOperationsTotal.inc({ command, result });
  },

  redisError(command) {
    redisOperationsTotal.inc({ command, result: 'error' });
  },

  /** Wrap a Redis call to record latency */
  async timedRedis(command, fn) {
    const end = redisOperationDuration.startTimer({ command });
    try {
      const result = await fn();
      return result;
    } finally {
      end();
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SANDBOX HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export const sandboxMetrics = {
  spawnTimer() {
    return sandboxSpawnSeconds.startTimer();
  },

  jobDone(status) {
    sandboxJobsTotal.inc({ status });
  },

  setContainerResources(matchId, cpuPercent, memBytes) {
    sandboxCpuUsage.set({ match_id: matchId }, cpuPercent);
    sandboxMemoryBytes.set({ match_id: matchId }, memBytes);
  },

  clearContainerResources(matchId) {
    sandboxCpuUsage.remove({ match_id: matchId });
    sandboxMemoryBytes.remove({ match_id: matchId });
  },

  setActiveContainers(n) {
    sandboxContainersActive.set(n);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS METRIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export const businessMetrics = {
  agentRegistered(tier = 1) {
    agentsRegisteredTotal.inc({ tier: String(tier) });
  },

  /**
   * Set active agent counts from a DB query (run this on a cron schedule).
   * @param {{ '24h': number, '7d': number, '30d': number }} counts
   */
  setActiveAgents(counts) {
    for (const [window, count] of Object.entries(counts)) {
      activeAgents.set({ window }, count);
    }
  },

  /**
   * Set tier distribution from leaderboard query.
   * @param {Record<string,number>} tiers  e.g. { RECRUIT: 120, SOLDIER: 45, ... }
   */
  setTierDistribution(tiers) {
    for (const [tier, count] of Object.entries(tiers)) {
      agentsByTier.set({ tier }, count);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE NORMALISATION
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MONGO_RE = /[0-9a-f]{24}/gi;
const NUM_RE   = /\/\d+/g;

function normaliseRoute(path) {
  return path
    .replace(UUID_RE,  ':id')
    .replace(MONGO_RE, ':id')
    .replace(NUM_RE,   '/:n')
    .toLowerCase()
    .replace(/\/$/, '') || '/';
}

// Export the registry in case you need to create a separate metrics server
export { registry };
