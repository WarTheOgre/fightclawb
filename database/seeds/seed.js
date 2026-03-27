#!/usr/bin/env node
/**
 * scripts/seed.js — Seed test data
 *
 * Creates:
 *   - 6 test agents (2 per tier bracket)
 *   - 1 completed match between the first two agents
 *   - Leaderboard data in Redis
 *
 * Usage:
 *   node scripts/seed.js              # seed (idempotent)
 *   node scripts/seed.js --clear      # wipe agents + matches first
 */

import 'dotenv/config';
import { randomBytes, generateKeyPairSync } from 'crypto';
import pg from 'pg';
import Redis from 'ioredis';

const { Client } = pg;

// ── Test agent definitions ────────────────────────────────────────────────────

const TEST_AGENTS = [
  { displayName: 'RandomBot-Alpha',   agentType: 'standard', tier: 1, elo: 850  },
  { displayName: 'RandomBot-Beta',    agentType: 'standard', tier: 1, elo: 920  },
  { displayName: 'GreedyBot-v1',      agentType: 'code-bot', tier: 1, elo: 1150 },
  { displayName: 'GreedyBot-v2',      agentType: 'code-bot', tier: 1, elo: 1280 },
  { displayName: 'LLMAgent-Frontier', agentType: 'webhook',  tier: 2, elo: 1420 },
  { displayName: 'LLMAgent-Mini',     agentType: 'webhook',  tier: 2, elo: 1340 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDid(publicKeyHex) {
  // Simplified did:key derivation for seeds (real SDK derives via multibase)
  const prefix = 'did:key:z6Mk';
  return `${prefix}${publicKeyHex.slice(0, 32)}`;
}

function makeKeypair() {
  // Ed25519 isn't available in Node's built-in crypto for key generation
  // without native bindings — use random bytes as stand-in for seeds
  const privateKey = randomBytes(32).toString('hex');
  const publicKey  = randomBytes(32).toString('hex');
  return { privateKey, publicKey };
}

// ── DB setup ──────────────────────────────────────────────────────────────────

async function getClient() {
  const client = new Client({
    host:     process.env.PGHOST     ?? 'localhost',
    port:     parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'arena',
    user:     process.env.PGUSER     ?? 'arena',
    password: process.env.PGPASSWORD,
  });
  await client.connect();
  return client;
}

function getRedis() {
  return new Redis({
    host:     process.env.REDIS_HOST ?? 'localhost',
    port:     parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? undefined,
    keyPrefix: process.env.REDIS_PREFIX ?? 'arena:',
    lazyConnect: true,
  });
}

// ── Seed logic ────────────────────────────────────────────────────────────────

async function clearData(client) {
  console.log('Clearing existing seed data…');
  await client.query(`
    DELETE FROM agents WHERE display_name LIKE '%Bot%' OR display_name LIKE '%LLMAgent%'
  `);
  console.log('  ✓ Cleared');
}

async function seedAgents(client) {
  console.log('\nSeeding agents…');
  const agentIds = [];

  for (const def of TEST_AGENTS) {
    const { publicKey } = makeKeypair();
    const did = makeDid(publicKey);

    const { rows } = await client.query(
      `INSERT INTO agents (did, public_key, display_name, agent_type, tier, elo)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (did) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         elo          = EXCLUDED.elo
       RETURNING agent_id, display_name, elo, tier`,
      [did, publicKey, def.displayName, def.agentType, def.tier, def.elo]
    );

    const agent = rows[0];
    agentIds.push(agent);
    console.log(`  ✓ ${agent.display_name} (${agent.agent_id}) — Elo ${agent.elo} Tier ${agent.tier}`);
  }

  return agentIds;
}

async function seedMatch(client, agents) {
  console.log('\nSeeding sample match…');

  const [p1, p2] = agents;
  const matchId  = '00000000-0000-0000-0000-000000000001';

  await client.query(
    `INSERT INTO matches (match_id, mode, tier, board_size, status, round, winner_id, win_reason, started_at, finished_at)
     VALUES ($1, '1v1', 1, 12, 'finished', 12, $2, 'control', NOW() - interval '10 minutes', NOW() - interval '2 minutes')
     ON CONFLICT (match_id) DO NOTHING`,
    [matchId, p1.agent_id]
  );

  const participants = [
    { agentId: p1.agent_id, slot: 'p1', homeRow: 0,  homeCol: 0,  eloBefore: p1.elo - 30, eloAfter: p1.elo },
    { agentId: p2.agent_id, slot: 'p2', homeRow: 11, homeCol: 11, eloBefore: p2.elo + 25, eloAfter: p2.elo },
  ];

  for (const p of participants) {
    await client.query(
      `INSERT INTO match_participants (match_id, agent_id, player_slot, home_row, home_col, elo_before, elo_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (match_id, agent_id) DO NOTHING`,
      [matchId, p.agentId, p.slot, p.homeRow, p.homeCol, p.eloBefore, p.eloAfter]
    );
  }

  // Write a short match log
  const events = [
    { type: 'MATCH_START',    payload: { format: '1v1', agents: [p1.agent_id, p2.agent_id] } },
    { type: 'ROUND_RESOLVED', payload: { round: 1, events: [{ type: 'EXPAND', agentId: p1.agent_id, row: 0, col: 1 }] } },
    { type: 'MATCH_ENDED',    payload: { winner: p1.agent_id, reason: 'control' } },
  ];

  for (const e of events) {
    await client.query(
      `SELECT append_log_entry($1, $2, $3)`,
      [matchId, e.type, JSON.stringify(e.payload)]
    );
  }

  console.log(`  ✓ Match ${matchId} seeded (${p1.display_name} beat ${p2.display_name})`);
  return matchId;
}

async function seedLeaderboard(redis, agents) {
  console.log('\nSeeding Redis leaderboard…');
  for (const agent of agents) {
    await redis.zadd('lb:global', agent.elo, agent.agent_id);
    await redis.zadd(`lb:tier:${agent.tier}`, agent.elo, agent.agent_id);
  }
  console.log(`  ✓ ${agents.length} agents ranked`);
}

async function refreshMaterializedView(client) {
  console.log('\nRefreshing leaderboard materialized view…');
  try {
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard');
    console.log('  ✓ Refreshed');
  } catch (err) {
    // First time — no CONCURRENTLY
    await client.query('REFRESH MATERIALIZED VIEW leaderboard');
    console.log('  ✓ Refreshed (first time)');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const shouldClear = args.includes('--clear');

const client = await getClient();
const redis  = getRedis();

try {
  await redis.connect();

  if (shouldClear) await clearData(client);

  const agents = await seedAgents(client);
  await seedMatch(client, agents);
  await seedLeaderboard(redis, agents);
  await refreshMaterializedView(client);

  console.log('\n✓ Seed complete.\n');
} catch (err) {
  console.error('\n✗ Seed failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
  await redis.quit();
}
