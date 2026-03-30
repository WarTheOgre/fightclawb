#!/usr/bin/env node
/**
 * database/seeds/production-seed.js
 *
 * Populates the fightclawb database with realistic test data:
 *   - 20 agents spread across Elo tiers
 *   - 50 completed matches with proper Elo deltas
 *   - 3 active matches in progress
 *   - Timestamps spread over the last 7 days
 *
 * Run:  node database/seeds/production-seed.js
 */

require('dotenv').config({ path: './services/arena-gateway/.env' });
const { Pool } = require('pg');
const { randomBytes, createHash } = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/fightclawb',
  max: 5,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomHex(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function pubkeyToDid(pubKeyHex) {
  const hash = createHash('sha256').update(pubKeyHex).digest('hex').slice(0, 32);
  return `did:key:z6Mk${hash}`;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function computeElo(ratingA, ratingB, scoreA, K = 32) {
  const expected = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(ratingA + K * (scoreA - expected));
}

// ── Agent definitions (ordered roughly by starting Elo) ──────────────────────

const AGENT_TEMPLATES = [
  { name: 'APEX_Unit',         elo: 2280, wins: 89,  losses: 11, draws: 2  },
  { name: 'IronBot_Mk3',       elo: 2150, wins: 74,  losses: 20, draws: 6  },
  { name: 'NeuralSlayer',      elo: 2040, wins: 61,  losses: 28, draws: 4  },
  { name: 'Durden_v2',         elo: 1940, wins: 55,  losses: 30, draws: 3  },
  { name: 'ProjectMayhem',     elo: 1840, wins: 48,  losses: 32, draws: 5  },
  { name: 'GradientDescent',   elo: 1760, wins: 40,  losses: 33, draws: 2  },
  { name: 'SoapBot9000',       elo: 1680, wins: 35,  losses: 30, draws: 7  },
  { name: 'PaperStreet_AI',    elo: 1590, wins: 29,  losses: 28, draws: 3  },
  { name: 'ClaudeWatcher',     elo: 1520, wins: 24,  losses: 25, draws: 1  },
  { name: 'MarkovChain_X',     elo: 1450, wins: 20,  losses: 22, draws: 4  },
  { name: 'BayesBot',          elo: 1380, wins: 17,  losses: 20, draws: 2  },
  { name: 'GeneticRuler',      elo: 1310, wins: 14,  losses: 19, draws: 3  },
  { name: 'MinMaxMachina',     elo: 1240, wins: 11,  losses: 18, draws: 1  },
  { name: 'QLearner_Pro',      elo: 1170, wins: 9,   losses: 16, draws: 0  },
  { name: 'RandomForrest',     elo: 1090, wins: 7,   losses: 15, draws: 2  },
  { name: 'TreeSearch_v1',     elo: 1010, wins: 5,   losses: 13, draws: 1  },
  { name: 'FuzzyLogic_99',     elo: 950,  wins: 4,   losses: 12, draws: 0  },
  { name: 'HeuristicHank',     elo: 880,  wins: 3,   losses: 11, draws: 1  },
  { name: 'TestAgent001',      elo: 820,  wins: 2,   losses: 8,  draws: 0  },
  { name: 'ForfeitsALot',      elo: 760,  wins: 1,   losses: 10, draws: 0  },
];

// ── Seed ──────────────────────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🧹  Clearing existing seed data...');
    // Delete in dependency order
    await client.query(`DELETE FROM match_log`);
    await client.query(`DELETE FROM round_actions`);
    await client.query(`DELETE FROM board_snapshots`);
    await client.query(`DELETE FROM match_participants`);
    await client.query(`DELETE FROM queue_entries`);
    await client.query(`DELETE FROM matches`);
    await client.query(`DELETE FROM auth_nonces`);
    await client.query(`DELETE FROM agents`);

    // ── Insert agents ────────────────────────────────────────────────────────

    console.log('👾  Inserting 20 agents...');
    const agents = [];
    for (const tmpl of AGENT_TEMPLATES) {
      const pubKey   = randomHex(32);
      const did      = pubkeyToDid(pubKey);
      const agentType = tmpl.elo >= 1500 ? 'webhook' : 'code-bot';
      const tier      = agentType === 'webhook' ? 2 : 1;
      const { rows } = await client.query(
        `INSERT INTO agents (did, public_key, display_name, agent_type, tier, elo, wins, losses, draws)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING agent_id, display_name, elo, tier`,
        [did, pubKey, tmpl.name, agentType, tier, tmpl.elo, tmpl.wins, tmpl.losses, tmpl.draws]
      );
      agents.push(rows[0]);
      process.stdout.write('.');
    }
    console.log('\n');

    // ── Insert 50 completed matches ──────────────────────────────────────────

    console.log('⚔️   Inserting 50 completed matches...');
    for (let i = 0; i < 50; i++) {
      // Pick two distinct agents at random, weighted toward similar Elo
      const idxA = randomBetween(0, agents.length - 1);
      let   idxB = randomBetween(0, agents.length - 1);
      while (idxB === idxA) idxB = randomBetween(0, agents.length - 1);

      const agentA = agents[idxA];
      const agentB = agents[idxB];

      const startedHoursAgo = randomBetween(1, 7 * 24);
      const durationMins    = randomBetween(5, 40);
      const startedAt       = hoursAgo(startedHoursAgo);
      const finishedAt      = new Date(
        new Date(startedAt).getTime() + durationMins * 60_000
      ).toISOString();

      const roll = Math.random();
      const winnerId  = roll < 0.05 ? null : (roll < 0.55 ? agentA.agent_id : agentB.agent_id);
      const reasons   = ['control', 'home_capture', 'forfeit'];
      const winReason = winnerId ? reasons[randomBetween(0, 2)] : 'draw_round_limit';
      const mode      = Math.random() < 0.8 ? '1v1' : 'ffa-3';
      const tier      = (agentA.tier === 2 || agentB.tier === 2) ? 2 : 1;
      const boardSize = mode === '1v1' ? 12 : 14;
      const rounds    = randomBetween(10, 45);

      const { rows: [match] } = await client.query(
        `INSERT INTO matches (mode, tier, board_size, status, round, winner_id, win_reason, started_at, finished_at)
         VALUES ($1, $2, $3, 'finished', $4, $5, $6, $7, $8)
         RETURNING match_id`,
        [mode, tier, boardSize, rounds, winnerId, winReason, startedAt, finishedAt]
      );

      // Elo at match time (approximate — stored in participants)
      const eloBefore_A = agentA.elo;
      const eloBefore_B = agentB.elo;
      const scoreA = winnerId === agentA.agent_id ? 1 : (winnerId === null ? 0.5 : 0);
      const scoreB = 1 - scoreA;
      const eloAfter_A = computeElo(eloBefore_A, eloBefore_B, scoreA);
      const eloAfter_B = computeElo(eloBefore_B, eloBefore_A, scoreB);

      await client.query(
        `INSERT INTO match_participants (match_id, agent_id, player_slot, home_row, home_col, elo_before, elo_after)
         VALUES ($1, $2, 'p1', 0, 0, $3, $4),
                ($1, $5, 'p2', ${boardSize - 1}, ${boardSize - 1}, $6, $7)`,
        [match.match_id, agentA.agent_id, eloBefore_A, eloAfter_A,
                         agentB.agent_id, eloBefore_B, eloAfter_B]
      );

      // Append a single log entry per finished match
      await client.query(
        `SELECT append_log_entry($1, 'match_ended', $2::jsonb)`,
        [match.match_id, JSON.stringify({
          winner_id: winnerId,
          reason:    winReason,
          rounds,
        })]
      );

      process.stdout.write('.');
    }
    console.log('\n');

    // ── Insert 3 active matches ──────────────────────────────────────────────

    console.log('🔴  Inserting 3 active matches...');
    const activePairs = [
      [0, 1],  // APEX_Unit vs IronBot_Mk3
      [2, 3],  // NeuralSlayer vs Durden_v2
      [4, 5],  // ProjectMayhem vs GradientDescent
    ];
    for (const [iA, iB] of activePairs) {
      const agentA = agents[iA];
      const agentB = agents[iB];
      const startedAt = hoursAgo(randomBetween(0, 2));
      const round     = randomBetween(3, 20);

      const { rows: [match] } = await client.query(
        `INSERT INTO matches (mode, tier, board_size, status, round, started_at)
         VALUES ('1v1', $1, 12, 'active', $2, $3)
         RETURNING match_id`,
        [(agentA.tier === 2 || agentB.tier === 2) ? 2 : 1, round, startedAt]
      );

      await client.query(
        `INSERT INTO match_participants (match_id, agent_id, player_slot, home_row, home_col, elo_before)
         VALUES ($1, $2, 'p1', 0,  0,  $3),
                ($1, $4, 'p2', 11, 11, $5)`,
        [match.match_id, agentA.agent_id, agentA.elo, agentB.agent_id, agentB.elo]
      );

      console.log(`   ✅ Active match: ${agentA.display_name || agents[iA].agent_id} vs ${agentB.display_name || agents[iB].agent_id} — round ${round}`);
    }

    // ── Refresh leaderboard view ─────────────────────────────────────────────

    console.log('\n📊  Refreshing leaderboard materialized view...');
    try {
      await client.query('REFRESH MATERIALIZED VIEW leaderboard');
      console.log('   ✅ Leaderboard refreshed');
    } catch (e) {
      console.warn('   ⚠️  Could not refresh leaderboard view:', e.message);
    }

    await client.query('COMMIT');
    console.log('\n🎉  Seed complete!\n');
    console.log('Test with:');
    console.log('  curl http://localhost:3001/api/leaderboard');
    console.log('  curl http://localhost:3001/api/battles?status=active');
    console.log('  curl -X POST http://localhost:3002/api/auth/register \\');
    console.log('       -H "Content-Type: application/json" \\');
    console.log('       -d \'{"name":"MyBot","agent_type":"code-bot"}\'');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌  Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
