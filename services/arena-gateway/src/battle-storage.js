// services/arena-gateway/src/battle-storage.js
// Database persistence for battle state — board snapshots, actions, match log, results

const crypto = require('crypto');
const { serializeBoard } = require('./board');

// ── Board snapshots ──────────────────────────────────────────────────────────

/**
 * Store a board snapshot for a given round.
 * Serialises the board to BYTEA via serializeBoard().
 */
async function storeBoardSnapshot(pool, matchId, round, boardState) {
  const cells = serializeBoard(boardState);
  const { rows } = await pool.query(
    `INSERT INTO board_snapshots (match_id, round, cells)
     VALUES ($1, $2, $3)
     ON CONFLICT (match_id, round) DO UPDATE SET cells = EXCLUDED.cells
     RETURNING snapshot_id`,
    [matchId, round, cells]
  );
  return rows[0].snapshot_id;
}

/**
 * Load a board snapshot for a given match and round.
 */
async function loadBoardSnapshot(pool, matchId, round) {
  const { rows } = await pool.query(
    `SELECT cells FROM board_snapshots
     WHERE match_id = $1 AND round = $2`,
    [matchId, round]
  );
  if (rows.length === 0) return null;
  return JSON.parse(rows[0].cells.toString());
}

// ── Round actions ────────────────────────────────────────────────────────────

/**
 * Store the actions an agent submitted for a round.
 *
 * The schema requires player_slot, nonce, and signature (NOT NULL).
 * For server-managed battles (no DID signing), we generate a nonce
 * and use 'server' as the signature.
 */
async function storeRoundActions(pool, matchId, agentId, playerSlot, round, actions) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO round_actions (match_id, round, agent_id, player_slot, actions_json, nonce, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (match_id, round, agent_id) DO UPDATE SET actions_json = EXCLUDED.actions_json
     RETURNING action_id`,
    [matchId, round, agentId, playerSlot, JSON.stringify(actions), nonce, 'server']
  );
  return rows[0].action_id;
}

// ── Match log (hash-chained) ─────────────────────────────────────────────────

/**
 * Append an event to the hash-chained match log.
 * Uses the existing append_log_entry() SQL function which handles
 * sequence numbering and SHA-256 hash chaining.
 */
async function appendMatchLog(pool, matchId, eventType, payload) {
  const { rows } = await pool.query(
    `SELECT * FROM append_log_entry($1, $2, $3)`,
    [matchId, eventType, JSON.stringify(payload)]
  );
  return rows[0];
}

// ── Match result ─────────────────────────────────────────────────────────────

/**
 * Mark a match as finished with the winner and reason.
 */
async function updateMatchResult(pool, matchId, winnerId, winReason, finalRound) {
  await pool.query(
    `UPDATE matches
     SET status = 'finished',
         winner_id = $1,
         win_reason = $2,
         round = $3,
         finished_at = NOW()
     WHERE match_id = $4`,
    [winnerId, winReason, finalRound, matchId]
  );
}

/**
 * Set started_at on a match transitioning to active.
 */
async function markMatchStarted(pool, matchId) {
  await pool.query(
    `UPDATE matches SET status = 'active', started_at = NOW() WHERE match_id = $1`,
    [matchId]
  );
}

// ── Agent stats ──────────────────────────────────────────────────────────────

/**
 * Update an agent's win/loss record and ELO after a match.
 *
 * @param {object}  pool
 * @param {string}  agentId
 * @param {boolean} won       - true = win, false = loss, null = draw
 * @param {number}  eloChange - signed ELO delta
 */
async function updateAgentStats(pool, agentId, won, eloChange) {
  const winsInc   = won === true  ? 1 : 0;
  const lossesInc = won === false ? 1 : 0;
  const drawsInc  = won === null  ? 1 : 0;

  const { rows } = await pool.query(
    `UPDATE agents
     SET wins   = wins   + $1,
         losses = losses + $2,
         draws  = draws  + $3,
         elo    = elo    + $4
     WHERE agent_id = $5
     RETURNING elo, wins, losses, draws`,
    [winsInc, lossesInc, drawsInc, eloChange, agentId]
  );
  return rows[0];
}

/**
 * Update elo_after for a participant in match_participants.
 */
async function updateParticipantElo(pool, matchId, agentId, eloAfter) {
  await pool.query(
    `UPDATE match_participants SET elo_after = $1 WHERE match_id = $2 AND agent_id = $3`,
    [eloAfter, matchId, agentId]
  );
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

/**
 * Refresh the materialised leaderboard view.
 * Uses CONCURRENTLY to avoid locking reads; falls back to blocking refresh
 * on first run (before any data exists in the unique index).
 */
async function refreshLeaderboard(pool) {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard');
  } catch {
    await pool.query('REFRESH MATERIALIZED VIEW leaderboard');
  }
}

module.exports = {
  storeBoardSnapshot,
  loadBoardSnapshot,
  storeRoundActions,
  appendMatchLog,
  updateMatchResult,
  markMatchStarted,
  updateAgentStats,
  updateParticipantElo,
  refreshLeaderboard,
};
