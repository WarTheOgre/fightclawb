/**
 * db/redis.js — Redis client (ioredis) with graceful degradation
 *
 * Key schema:
 *   arena:match:{id}:state        STRING  2h   Full game state JSON
 *   arena:match:{id}:phase        STRING  2h   Current phase
 *   arena:match:{id}:round        STRING  2h   Current round number
 *   arena:queue:{tier}:{mode}     ZSET    —    score=epoch-ms, member=agentId:elo
 *   arena:lb:global               ZSET    —    score=elo, member=agentId
 *   arena:lb:tier:{tier}          ZSET    —    score=elo, member=agentId
 *   arena:session:{token}         STRING  1h   JWT → agentId
 *   arena:agent:{id}:profile      STRING  5m   Agent profile micro-cache
 *
 * Usage:
 *   import { redis, matchState, leaderboard } from '../../db/redis.js';
 */

import Redis from 'ioredis';
import 'dotenv/config';

// ── Client setup ─────────────────────────────────────────────────────────────

const REDIS_PREFIX = process.env.REDIS_PREFIX ?? 'arena:';

const redisConfig = {
  host:               process.env.REDIS_HOST     ?? 'localhost',
  port:               parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password:           process.env.REDIS_PASSWORD ?? undefined,
  keyPrefix:          REDIS_PREFIX,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null; // stop retrying — fall back to degraded mode
    return Math.min(times * 200, 2000);
  },
  lazyConnect: true,
};

export const redis = new Redis(redisConfig);

redis.healthy = false;

redis.on('connect',   () => { redis.healthy = true;  console.log('[redis] Connected'); });
redis.on('close',     () => { redis.healthy = false; console.warn('[redis] Disconnected'); });
redis.on('error',     (err) => {
  redis.healthy = false;
  // Don't throw — redis errors should not crash the process
  console.error('[redis] Error:', err.message);
});

// ── Initialise ───────────────────────────────────────────────────────────────

export async function initRedis() {
  try {
    await redis.connect();
    await redis.ping();
    redis.healthy = true;
    return true;
  } catch (err) {
    console.error('[redis] Could not connect:', err.message);
    redis.healthy = false;
    return false;
  }
}

// ── Safe wrapper ─────────────────────────────────────────────────────────────

/**
 * Wraps a redis operation — returns null instead of throwing if redis is down.
 * Use for non-critical caching; for critical ops (queue), let errors propagate.
 */
async function safe(fn) {
  if (!redis.healthy) return null;
  try {
    return await fn();
  } catch (err) {
    console.error('[redis] Safe op failed:', err.message);
    return null;
  }
}

// ── Match state helpers ──────────────────────────────────────────────────────

const MATCH_TTL = 2 * 60 * 60; // 2 hours in seconds

export const matchState = {
  /** Store full game state JSON for a match. */
  async set(matchId, state) {
    return safe(() => redis.setex(`match:${matchId}:state`, MATCH_TTL, JSON.stringify(state)));
  },

  /** Retrieve full game state. Returns parsed object or null. */
  async get(matchId) {
    const raw = await safe(() => redis.get(`match:${matchId}:state`));
    return raw ? JSON.parse(raw) : null;
  },

  /** Update just the phase string. */
  async setPhase(matchId, phase) {
    return safe(() => redis.setex(`match:${matchId}:phase`, MATCH_TTL, phase));
  },

  /** Update just the round number. */
  async setRound(matchId, round) {
    return safe(() => redis.setex(`match:${matchId}:round`, MATCH_TTL, String(round)));
  },

  /** Delete all keys for a match (post-settlement cleanup). */
  async del(matchId) {
    return safe(() => redis.del(
      `match:${matchId}:state`,
      `match:${matchId}:phase`,
      `match:${matchId}:round`,
    ));
  },
};

// ── Queue helpers ─────────────────────────────────────────────────────────────

export const queue = {
  /**
   * Add an agent to the matchmaking queue.
   * Score = join timestamp (ms) for FIFO ordering within Elo range.
   * Member = "agentId:elo" so we can filter by Elo from Redis directly.
   */
  async add(tier, mode, agentId, elo) {
    const key    = `queue:${tier}:${mode}`;
    const member = `${agentId}:${elo}`;
    await redis.zadd(key, Date.now(), member);
  },

  /** Remove an agent from the queue. */
  async remove(tier, mode, agentId) {
    const key = `queue:${tier}:${mode}`;
    // Scan for any member starting with agentId: (elo might have changed)
    const all = await redis.zrange(key, 0, -1);
    const toRemove = all.filter(m => m.startsWith(`${agentId}:`));
    if (toRemove.length) await redis.zrem(key, ...toRemove);
  },

  /**
   * Fetch all waiting agents, sorted by join time.
   * Returns [{ agentId, elo, score }]
   */
  async list(tier, mode) {
    const key     = `queue:${tier}:${mode}`;
    const members = await redis.zrange(key, 0, -1, 'WITHSCORES');
    const result  = [];
    for (let i = 0; i < members.length; i += 2) {
      const [agentId, eloStr] = members[i].split(':');
      result.push({ agentId, elo: parseInt(eloStr, 10), joinedAt: parseInt(members[i + 1], 10) });
    }
    return result;
  },

  /** Count waiting agents in a queue. */
  async count(tier, mode) {
    return redis.zcard(`queue:${tier}:${mode}`);
  },
};

// ── Leaderboard helpers ───────────────────────────────────────────────────────

export const leaderboard = {
  /** Upsert an agent's Elo score in global + tier leaderboards. */
  async update(agentId, elo, tier) {
    await safe(() => Promise.all([
      redis.zadd('lb:global',      elo, agentId),
      redis.zadd(`lb:tier:${tier}`, elo, agentId),
    ]));
  },

  /** Fetch top N agents from global leaderboard. Returns [{ agentId, elo, rank }] */
  async topGlobal(n = 100) {
    return safe(async () => {
      const members = await redis.zrevrange('lb:global', 0, n - 1, 'WITHSCORES');
      return membersToRanked(members);
    }) ?? [];
  },

  /** Fetch top N agents from tier leaderboard. */
  async topTier(tier, n = 100) {
    return safe(async () => {
      const members = await redis.zrevrange(`lb:tier:${tier}`, 0, n - 1, 'WITHSCORES');
      return membersToRanked(members);
    }) ?? [];
  },

  /** Get an agent's rank and Elo from global board. Returns null if not ranked. */
  async getRank(agentId) {
    return safe(async () => {
      const [rank, elo] = await Promise.all([
        redis.zrevrank('lb:global', agentId),
        redis.zscore('lb:global', agentId),
      ]);
      if (rank === null) return null;
      return { rank: rank + 1, elo: parseFloat(elo) };
    });
  },
};

// ── Session helpers ───────────────────────────────────────────────────────────

const SESSION_TTL = 60 * 60; // 1 hour

export const sessions = {
  async set(token, agentId) {
    return safe(() => redis.setex(`session:${token}`, SESSION_TTL, agentId));
  },

  async get(token) {
    return safe(() => redis.get(`session:${token}`));
  },

  async del(token) {
    return safe(() => redis.del(`session:${token}`));
  },
};

// ── Agent profile micro-cache ─────────────────────────────────────────────────

const PROFILE_TTL = 5 * 60; // 5 minutes

export const profileCache = {
  async set(agentId, profile) {
    return safe(() => redis.setex(`agent:${agentId}:profile`, PROFILE_TTL, JSON.stringify(profile)));
  },

  async get(agentId) {
    const raw = await safe(() => redis.get(`agent:${agentId}:profile`));
    return raw ? JSON.parse(raw) : null;
  },

  async del(agentId) {
    return safe(() => redis.del(`agent:${agentId}:profile`));
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function membersToRanked(members) {
  const result = [];
  for (let i = 0; i < members.length; i += 2) {
    result.push({ agentId: members[i], elo: parseFloat(members[i + 1]), rank: Math.floor(i / 2) + 1 });
  }
  return result;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

export async function closeRedis() {
  await redis.quit();
  console.log('[redis] Connection closed');
}

process.on('SIGTERM', closeRedis);
process.on('SIGINT',  closeRedis);
