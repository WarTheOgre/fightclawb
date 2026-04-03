const assert = require('assert');
const { Pool } = require('pg');
const BattleEngine = require('../src/battle-engine');
const { MAX_TURNS } = require('../src/board');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/fightclawb',
  max: 5,
});

const AGENT1_ID = '33333333-3333-3333-3333-333333333333';
const AGENT2_ID = '44444444-4444-4444-4444-444444444444';
let MATCH_ID;

const agent1 = { agent_id: AGENT1_ID, display_name: 'EngineBot-1', elo: 1000 };
const agent2 = { agent_id: AGENT2_ID, display_name: 'EngineBot-2', elo: 1000 };

before(async function () {
  this.timeout(10000);

  await pool.query(`
    INSERT INTO agents (agent_id, did, public_key, display_name, agent_type, tier, elo)
    VALUES ($1, 'did:test:engine1', 'pk-engine-1', 'EngineBot-1', 'code-bot', 1, 1000),
           ($2, 'did:test:engine2', 'pk-engine-2', 'EngineBot-2', 'code-bot', 1, 1000)
    ON CONFLICT (agent_id) DO UPDATE SET elo = 1000, wins = 0, losses = 0, draws = 0
  `, [AGENT1_ID, AGENT2_ID]);

  const { rows } = await pool.query(`
    INSERT INTO matches (mode, tier, board_size, status)
    VALUES ('1v1', 1, 12, 'lobby')
    RETURNING match_id
  `);
  MATCH_ID = rows[0].match_id;

  await pool.query(`
    INSERT INTO match_participants (match_id, agent_id, player_slot, home_row, home_col, elo_before)
    VALUES ($1, $2, 'p1', 0, 0, 1000),
           ($1, $3, 'p2', 11, 11, 1000)
  `, [MATCH_ID, AGENT1_ID, AGENT2_ID]);
});

after(async () => {
  if (MATCH_ID) {
    await pool.query('DELETE FROM match_log WHERE match_id = $1', [MATCH_ID]);
    await pool.query('DELETE FROM round_actions WHERE match_id = $1', [MATCH_ID]);
    await pool.query('DELETE FROM board_snapshots WHERE match_id = $1', [MATCH_ID]);
    await pool.query('DELETE FROM match_participants WHERE match_id = $1', [MATCH_ID]);
    await pool.query('DELETE FROM matches WHERE match_id = $1', [MATCH_ID]);
  }
  await pool.query('DELETE FROM agents WHERE agent_id IN ($1, $2)', [AGENT1_ID, AGENT2_ID]);
  await pool.end();
});

describe('BattleEngine', function () {
  this.timeout(30000);

  let result;

  it('runs a complete battle to conclusion', async () => {
    const engine = new BattleEngine(MATCH_ID, agent1, agent2, pool);
    result = await engine.run();
    assert.strictEqual(result.finished, true);
    assert.ok(
      ['territory', 'home_captured', 'turn_limit', 'draw'].includes(result.reason),
      `Unexpected reason: ${result.reason}`
    );
  });

  it('match is marked finished with winner', async () => {
    const { rows } = await pool.query(
      'SELECT status, winner_id, win_reason, round, started_at, finished_at FROM matches WHERE match_id = $1',
      [MATCH_ID]
    );
    assert.strictEqual(rows[0].status, 'finished');
    assert.ok(rows[0].started_at, 'started_at should be set');
    assert.ok(rows[0].finished_at, 'finished_at should be set');
    assert.ok(rows[0].round > 0, 'round should be > 0');
    assert.strictEqual(rows[0].win_reason, result.reason);
  });

  it('stored board snapshots (initial + each round)', async () => {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count, MIN(round)::int AS min_round, MAX(round)::int AS max_round FROM board_snapshots WHERE match_id = $1',
      [MATCH_ID]
    );
    assert.ok(rows[0].count >= 2, `Expected at least 2 snapshots, got ${rows[0].count}`);
    assert.strictEqual(rows[0].min_round, 0, 'Should have initial snapshot at round 0');
    assert.ok(rows[0].max_round > 0, 'Should have at least one round snapshot');
  });

  it('stored round actions for both agents', async () => {
    const { rows } = await pool.query(
      `SELECT agent_id, COUNT(*)::int AS count
       FROM round_actions WHERE match_id = $1
       GROUP BY agent_id ORDER BY agent_id`,
      [MATCH_ID]
    );
    assert.strictEqual(rows.length, 2, 'Should have actions for both agents');
    // Both agents should have the same number of action records
    assert.ok(rows[0].count > 0);
    // Agent 1 might have 1 more round if the battle ended on agent 1's move
    assert.ok(Math.abs(rows[0].count - rows[1].count) <= 1);
  });

  it('match log has hash-chained events', async () => {
    const { rows } = await pool.query(
      `SELECT seq, event_type, prev_hash, entry_hash
       FROM match_log WHERE match_id = $1 ORDER BY seq`,
      [MATCH_ID]
    );
    assert.ok(rows.length >= 3, `Expected at least 3 log entries (start + rounds + end), got ${rows.length}`);
    assert.strictEqual(rows[0].event_type, 'MATCH_START');
    assert.strictEqual(rows[rows.length - 1].event_type, 'MATCH_ENDED');

    // Verify chain integrity
    assert.strictEqual(rows[0].prev_hash, null, 'First entry should have null prev_hash');
    for (let i = 1; i < rows.length; i++) {
      assert.strictEqual(rows[i].prev_hash, rows[i - 1].entry_hash,
        `Hash chain broken at seq ${rows[i].seq}`);
    }
  });

  it('agent stats updated (winner gained ELO, loser lost ELO)', async () => {
    const { rows } = await pool.query(
      'SELECT agent_id, elo, wins, losses, draws FROM agents WHERE agent_id IN ($1, $2) ORDER BY agent_id',
      [AGENT1_ID, AGENT2_ID]
    );
    const a1 = rows.find(r => r.agent_id === AGENT1_ID);
    const a2 = rows.find(r => r.agent_id === AGENT2_ID);

    if (result.winner_id === AGENT1_ID) {
      assert.strictEqual(a1.elo, 1030);
      assert.strictEqual(a1.wins, 1);
      assert.strictEqual(a2.elo, 970);
      assert.strictEqual(a2.losses, 1);
    } else if (result.winner_id === AGENT2_ID) {
      assert.strictEqual(a2.elo, 1030);
      assert.strictEqual(a2.wins, 1);
      assert.strictEqual(a1.elo, 970);
      assert.strictEqual(a1.losses, 1);
    } else {
      // Draw
      assert.strictEqual(a1.elo, 1000);
      assert.strictEqual(a2.elo, 1000);
      assert.strictEqual(a1.draws, 1);
      assert.strictEqual(a2.draws, 1);
    }
  });

  it('participant elo_after updated', async () => {
    const { rows } = await pool.query(
      'SELECT agent_id, elo_before, elo_after FROM match_participants WHERE match_id = $1 ORDER BY agent_id',
      [MATCH_ID]
    );
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.elo_after !== null, `elo_after should be set for ${row.agent_id}`);
      assert.strictEqual(row.elo_before, 1000);
    }
  });

  it('leaderboard refreshed with updated ELOs', async () => {
    const { rows } = await pool.query(
      'SELECT agent_id, elo FROM leaderboard WHERE agent_id IN ($1, $2)',
      [AGENT1_ID, AGENT2_ID]
    );
    assert.strictEqual(rows.length, 2);
    const elos = rows.map(r => r.elo).sort((a, b) => b - a);
    assert.deepStrictEqual(elos, [1030, 970]);
  });
});
