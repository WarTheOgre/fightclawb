const assert = require('assert');
const { Pool } = require('pg');
const { createBoard, applyMove } = require('../src/board');
const {
  storeBoardSnapshot,
  loadBoardSnapshot,
  storeRoundActions,
  appendMatchLog,
  updateMatchResult,
  markMatchStarted,
  updateAgentStats,
  updateParticipantElo,
  refreshLeaderboard,
} = require('../src/battle-storage');

// Connect to the fightclawb database (same as the running services)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/fightclawb',
  max: 3,
});

// Test fixtures — use dedicated UUIDs to avoid colliding with seed data
const AGENT1 = '11111111-1111-1111-1111-111111111111';
const AGENT2 = '22222222-2222-2222-2222-222222222222';
let MATCH_ID;

before(async () => {
  // Insert test agents
  await pool.query(`
    INSERT INTO agents (agent_id, did, public_key, display_name, agent_type, tier, elo)
    VALUES ($1, 'did:test:agent1', 'pk-test-1', 'TestBot-1', 'standard', 1, 1000),
           ($2, 'did:test:agent2', 'pk-test-2', 'TestBot-2', 'standard', 1, 1000)
    ON CONFLICT (agent_id) DO NOTHING
  `, [AGENT1, AGENT2]);

  // Create a test match
  const { rows } = await pool.query(`
    INSERT INTO matches (mode, tier, board_size, status)
    VALUES ('1v1', 1, 12, 'lobby')
    RETURNING match_id
  `);
  MATCH_ID = rows[0].match_id;

  // Add participants
  await pool.query(`
    INSERT INTO match_participants (match_id, agent_id, player_slot, home_row, home_col, elo_before)
    VALUES ($1, $2, 'p1', 0, 0, 1000),
           ($1, $3, 'p2', 11, 11, 1000)
  `, [MATCH_ID, AGENT1, AGENT2]);
});

after(async () => {
  // Clean up test data in dependency order
  await pool.query('DELETE FROM match_log WHERE match_id = $1', [MATCH_ID]);
  await pool.query('DELETE FROM round_actions WHERE match_id = $1', [MATCH_ID]);
  await pool.query('DELETE FROM board_snapshots WHERE match_id = $1', [MATCH_ID]);
  await pool.query('DELETE FROM match_participants WHERE match_id = $1', [MATCH_ID]);
  await pool.query('DELETE FROM matches WHERE match_id = $1', [MATCH_ID]);
  await pool.query('DELETE FROM agents WHERE agent_id IN ($1, $2)', [AGENT1, AGENT2]);
  await pool.end();
});

describe('storeBoardSnapshot / loadBoardSnapshot', () => {
  it('stores and retrieves a board snapshot', async () => {
    const board = createBoard(AGENT1, AGENT2);
    applyMove(board, AGENT1, { type: 'EXPAND', row: 0, col: 1 });

    const snapshotId = await storeBoardSnapshot(pool, MATCH_ID, 1, board);
    assert.ok(snapshotId);

    const loaded = await loadBoardSnapshot(pool, MATCH_ID, 1);
    assert.strictEqual(loaded.turn, board.turn);
    assert.strictEqual(loaded.cells[0][1].owner, AGENT1);
    assert.strictEqual(loaded.scores[AGENT1], 2);
  });

  it('upserts on conflict (same match + round)', async () => {
    const board = createBoard(AGENT1, AGENT2);
    board.turn = 99;
    const id = await storeBoardSnapshot(pool, MATCH_ID, 1, board);
    assert.ok(id);

    const loaded = await loadBoardSnapshot(pool, MATCH_ID, 1);
    assert.strictEqual(loaded.turn, 99);
  });

  it('returns null for non-existent snapshot', async () => {
    const loaded = await loadBoardSnapshot(pool, MATCH_ID, 999);
    assert.strictEqual(loaded, null);
  });
});

describe('storeRoundActions', () => {
  it('stores agent actions for a round', async () => {
    const actions = [
      { type: 'EXPAND', row: 0, col: 1, apCost: 1 },
      { type: 'FORTIFY', row: 0, col: 0, apCost: 2 },
    ];
    const actionId = await storeRoundActions(pool, MATCH_ID, AGENT1, 'p1', 1, actions);
    assert.ok(actionId);

    // Verify in DB
    const { rows } = await pool.query(
      'SELECT actions_json, nonce, signature FROM round_actions WHERE action_id = $1',
      [actionId]
    );
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].actions_json, actions);
    assert.strictEqual(rows[0].nonce.length, 32); // 16 bytes hex
    assert.strictEqual(rows[0].signature, 'server');
  });
});

describe('appendMatchLog', () => {
  it('appends events with sequential seq numbers', async () => {
    const e1 = await appendMatchLog(pool, MATCH_ID, 'MATCH_START', {
      agents: [AGENT1, AGENT2],
    });
    assert.strictEqual(e1.seq, 0);
    assert.strictEqual(e1.event_type, 'MATCH_START');
    assert.strictEqual(e1.prev_hash, null);
    assert.ok(e1.entry_hash);

    const e2 = await appendMatchLog(pool, MATCH_ID, 'ROUND_RESOLVED', {
      round: 1,
    });
    assert.strictEqual(e2.seq, 1);
    assert.strictEqual(e2.prev_hash, e1.entry_hash);
    assert.ok(e2.entry_hash);
    assert.notStrictEqual(e2.entry_hash, e1.entry_hash);
  });

  it('hash chain is intact', async () => {
    const { rows } = await pool.query(
      'SELECT seq, entry_hash, prev_hash FROM match_log WHERE match_id = $1 ORDER BY seq',
      [MATCH_ID]
    );
    for (let i = 1; i < rows.length; i++) {
      assert.strictEqual(rows[i].prev_hash, rows[i - 1].entry_hash);
    }
  });
});

describe('markMatchStarted', () => {
  it('sets status to active and started_at', async () => {
    await markMatchStarted(pool, MATCH_ID);
    const { rows } = await pool.query(
      'SELECT status, started_at FROM matches WHERE match_id = $1',
      [MATCH_ID]
    );
    assert.strictEqual(rows[0].status, 'active');
    assert.ok(rows[0].started_at);
  });
});

describe('updateMatchResult', () => {
  it('marks match as finished with winner and reason', async () => {
    await updateMatchResult(pool, MATCH_ID, AGENT1, 'territory', 42);
    const { rows } = await pool.query(
      'SELECT status, winner_id, win_reason, round, finished_at FROM matches WHERE match_id = $1',
      [MATCH_ID]
    );
    assert.strictEqual(rows[0].status, 'finished');
    assert.strictEqual(rows[0].winner_id, AGENT1);
    assert.strictEqual(rows[0].win_reason, 'territory');
    assert.strictEqual(rows[0].round, 42);
    assert.ok(rows[0].finished_at);
  });
});

describe('updateAgentStats', () => {
  it('increments wins and ELO for winner', async () => {
    const result = await updateAgentStats(pool, AGENT1, true, 20);
    assert.strictEqual(result.wins, 1);
    assert.strictEqual(result.elo, 1020);
  });

  it('increments losses and decreases ELO for loser', async () => {
    const result = await updateAgentStats(pool, AGENT2, false, -20);
    assert.strictEqual(result.losses, 1);
    assert.strictEqual(result.elo, 980);
  });

  it('increments draws for a draw', async () => {
    const result = await updateAgentStats(pool, AGENT1, null, 0);
    assert.strictEqual(result.draws, 1);
    assert.strictEqual(result.elo, 1020); // unchanged
  });
});

describe('updateParticipantElo', () => {
  it('sets elo_after for a participant', async () => {
    await updateParticipantElo(pool, MATCH_ID, AGENT1, 1020);
    const { rows } = await pool.query(
      'SELECT elo_after FROM match_participants WHERE match_id = $1 AND agent_id = $2',
      [MATCH_ID, AGENT1]
    );
    assert.strictEqual(rows[0].elo_after, 1020);
  });
});

describe('refreshLeaderboard', () => {
  it('refreshes without error', async () => {
    await refreshLeaderboard(pool);
    const { rows } = await pool.query(
      'SELECT * FROM leaderboard WHERE agent_id = $1', [AGENT1]
    );
    assert.ok(rows.length > 0);
    assert.strictEqual(rows[0].display_name, 'TestBot-1');
  });
});
