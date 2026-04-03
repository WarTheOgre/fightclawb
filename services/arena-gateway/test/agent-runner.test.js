const assert = require('assert');
const path = require('path');
const { Pool } = require('pg');
const { executeAgent } = require('../src/agent-runner');
const { createBoard, getValidMoves, AP_PER_TURN } = require('../src/board');
const BattleEngine = require('../src/battle-engine');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/fightclawb',
  max: 5,
});

const TEST_AGENTS_DIR = process.env.TEST_AGENTS_DIR || path.resolve(__dirname, '../../../test-agents');

const AGENT1_ID = 'aaaa1111-aaaa-1111-aaaa-111111111111';
const AGENT2_ID = 'bbbb2222-bbbb-2222-bbbb-222222222222';
let MATCH_ID;

const agent1 = {
  agent_id: AGENT1_ID,
  display_name: 'SimpleExpander',
  elo: 1000,
  code_path: path.join(TEST_AGENTS_DIR, 'simple-expander.js'),
};
const agent2 = {
  agent_id: AGENT2_ID,
  display_name: 'AggressiveAttacker',
  elo: 1000,
  code_path: path.join(TEST_AGENTS_DIR, 'aggressive-attacker.js'),
};

before(async function () {
  this.timeout(10000);

  await pool.query(`
    INSERT INTO agents (agent_id, did, public_key, display_name, agent_type, tier, elo, code_path)
    VALUES ($1, 'did:test:expand', 'pk-expand-1', 'SimpleExpander', 'code-bot', 1, 1000, $3),
           ($2, 'did:test:attack', 'pk-attack-1', 'AggressiveAttacker', 'code-bot', 1, 1000, $4)
    ON CONFLICT (agent_id) DO UPDATE SET
      elo = 1000, wins = 0, losses = 0, draws = 0,
      code_path = EXCLUDED.code_path
  `, [AGENT1_ID, AGENT2_ID, agent1.code_path, agent2.code_path]);

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

// ── Unit: executeAgent ───────────────────────────────────────────────────────

describe('executeAgent', function () {
  this.timeout(15000);

  it('executes simple-expander and returns valid actions', async () => {
    const board = createBoard(AGENT1_ID, AGENT2_ID);
    const actions = await executeAgent(agent1, board, 1);

    assert.ok(Array.isArray(actions), 'Should return an array');
    assert.ok(actions.length > 0, 'Should return at least one action');

    // All actions should be valid types
    for (const a of actions) {
      assert.ok(['EXPAND', 'FORTIFY', 'ATTACK'].includes(a.type), `Invalid type: ${a.type}`);
      assert.ok(typeof a.row === 'number');
      assert.ok(typeof a.col === 'number');
    }

    // Total AP should not exceed budget
    let ap = 0;
    for (const a of actions) {
      ap += a.apCost || (a.type === 'FORTIFY' ? 2 : 1);
    }
    assert.ok(ap <= AP_PER_TURN, `AP ${ap} exceeds budget ${AP_PER_TURN}`);
  });

  it('executes aggressive-attacker and returns valid actions', async () => {
    const board = createBoard(AGENT1_ID, AGENT2_ID);
    const actions = await executeAgent(agent2, board, 1);

    assert.ok(Array.isArray(actions));
    assert.ok(actions.length > 0);
  });

  it('returns empty array for missing code_path', async () => {
    const board = createBoard(AGENT1_ID, AGENT2_ID);
    const badAgent = { ...agent1, code_path: '/nonexistent/agent.js' };
    const actions = await executeAgent(badAgent, board, 1);
    assert.deepStrictEqual(actions, []);
  });
});

// ── Integration: full battle with real agents ────────────────────────────────

describe('BattleEngine with real agents', function () {
  this.timeout(120000);

  let result;

  it('runs a complete battle with agent code execution', async () => {
    const engine = new BattleEngine(MATCH_ID, agent1, agent2, pool);
    result = await engine.run();
    assert.strictEqual(result.finished, true);
    assert.ok(result.reason, 'Should have a win reason');
    console.log(`  Result: ${result.winner_id === AGENT1_ID ? 'SimpleExpander' : result.winner_id === AGENT2_ID ? 'AggressiveAttacker' : 'Draw'} — ${result.reason}`);
  });

  it('match is finished in database', async () => {
    const { rows } = await pool.query(
      'SELECT status, winner_id, win_reason, round FROM matches WHERE match_id = $1',
      [MATCH_ID]
    );
    assert.strictEqual(rows[0].status, 'finished');
    assert.ok(rows[0].round > 0);
  });

  it('round_actions contain agent-generated moves', async () => {
    const { rows } = await pool.query(
      `SELECT ra.round, ra.agent_id, ra.actions_json
       FROM round_actions ra WHERE ra.match_id = $1
       ORDER BY ra.round, ra.agent_id LIMIT 4`,
      [MATCH_ID]
    );
    assert.ok(rows.length >= 2, 'Should have actions from both agents');

    // Actions should contain EXPAND moves (both agents prioritize expansion)
    const firstActions = rows[0].actions_json;
    assert.ok(Array.isArray(firstActions));
    const expandCount = firstActions.filter(a => a.type === 'EXPAND').length;
    assert.ok(expandCount > 0, 'Agent should have generated EXPAND actions');
  });

  it('board snapshots show territory progression', async () => {
    const { rows } = await pool.query(
      `SELECT round, LENGTH(cells) as size FROM board_snapshots
       WHERE match_id = $1 ORDER BY round`,
      [MATCH_ID]
    );
    assert.ok(rows.length >= 2);
    // Later snapshots should be larger (more owned cells = more data)
    assert.ok(rows[rows.length - 1].size > rows[0].size,
      'Final snapshot should be larger than initial (territory gained)');
  });

  it('leaderboard updated with battle results', async () => {
    const { rows } = await pool.query(
      'SELECT agent_id, elo, wins, losses FROM leaderboard WHERE agent_id IN ($1, $2)',
      [AGENT1_ID, AGENT2_ID]
    );
    assert.strictEqual(rows.length, 2);
    const winner = rows.find(r => r.wins === 1);
    const loser = rows.find(r => r.losses === 1);
    assert.ok(winner, 'One agent should have 1 win');
    assert.ok(loser, 'One agent should have 1 loss');
    assert.strictEqual(winner.elo, 1030);
    assert.strictEqual(loser.elo, 970);
  });
});
