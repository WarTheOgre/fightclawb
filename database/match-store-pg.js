/**
 * engine/match-store-pg.js — Match persistence layer
 *
 * Handles durable writes for match lifecycle events:
 *   - Match creation and participant registration
 *   - Round action logging (signed moves)
 *   - Board snapshot storage (one per round-resolved)
 *   - Hash-chained log entries (via append_log_entry SQL fn)
 *   - Settlement: winner, Elo updates, participant outcomes
 *
 * The hot path (active match state) lives in Redis and the in-memory
 * Match object. This module is for durable storage only.
 *
 * Usage (via match-manager-db-hooks.js — don't call directly):
 *   import { matchStorePg } from './match-store-pg.js';
 */

import { query, transaction } from '../../db/pool.js';
import { matchState as redisMatchState } from '../../db/redis.js';

export const matchStorePg = {

  // ── Match creation ──────────────────────────────────────────────────────

  /**
   * Persist a new match record plus participant rows.
   * Call this when the match leaves LOBBY (credits consumed).
   *
   * @param {object} match  - Match instance from match-manager.js
   */
  async createMatch(match) {
    const modeToBoard = { '1v1': 12, 'ffa-3': 14, 'ffa-4': 16 };
    const boardSize   = modeToBoard[match.format] ?? 12;
    const tier        = match.agentSlots.some(s => s.tier === 2) ? 2 : 1;

    await transaction(async (client) => {
      // Insert match row
      await client.query(
        `INSERT INTO matches (match_id, mode, tier, board_size, status, started_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())
         ON CONFLICT (match_id) DO UPDATE
           SET status = 'active', started_at = COALESCE(matches.started_at, NOW())`,
        [match.matchId, match.format, tier, boardSize]
      );

      // Insert participants
      const slots = ['p1', 'p2', 'p3', 'p4'];
      for (let i = 0; i < match.agentSlots.length; i++) {
        const { agentId } = match.agentSlots[i];
        const gamePlayer  = match.gameState?.players?.[i];
        const homeRow     = gamePlayer?.homeCell?.row ?? 0;
        const homeCol     = gamePlayer?.homeCell?.col ?? 0;

        // Fetch current Elo for snapshot
        const eloRes = await client.query(
          'SELECT elo FROM agents WHERE agent_id = $1',
          [agentId]
        );
        const eloBefore = eloRes.rows[0]?.elo ?? 1000;

        await client.query(
          `INSERT INTO match_participants
             (match_id, agent_id, player_slot, home_row, home_col, elo_before)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (match_id, agent_id) DO NOTHING`,
          [match.matchId, agentId, slots[i], homeRow, homeCol, eloBefore]
        );
      }
    });
  },

  // ── Round data ──────────────────────────────────────────────────────────

  /**
   * Persist one agent's signed move submission for a round.
   * Idempotent (ON CONFLICT DO NOTHING).
   */
  async persistRoundAction(matchId, round, agentId, playerSlot, actions, nonce, signature) {
    await query(
      `INSERT INTO round_actions
         (match_id, round, agent_id, player_slot, actions_json, nonce, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (match_id, round, agent_id) DO NOTHING`,
      [matchId, round, agentId, playerSlot, JSON.stringify(actions), nonce, signature]
    );
  },

  /**
   * Persist a board snapshot after round resolution.
   * Cells are stored as compact binary (1 byte per cell).
   */
  async persistBoardSnapshot(matchId, round, cells, size) {
    const buf = encodeCells(cells, size);
    await query(
      `INSERT INTO board_snapshots (match_id, round, cells)
       VALUES ($1, $2, $3)
       ON CONFLICT (match_id, round) DO NOTHING`,
      [matchId, round, buf]
    );
  },

  // ── Hash-chained log ────────────────────────────────────────────────────

  /**
   * Append an event to the durable hash-chained log.
   * Uses the append_log_entry() SQL function for atomic hash computation.
   */
  async appendLog(matchId, eventType, payload) {
    const { rows } = await query(
      `SELECT * FROM append_log_entry($1, $2, $3)`,
      [matchId, eventType, JSON.stringify(payload)]
    );
    return rows[0];
  },

  // ── Match round update ──────────────────────────────────────────────────

  /** Update the current round counter on the match row. */
  async updateRound(matchId, round) {
    await query(
      'UPDATE matches SET round = $1 WHERE match_id = $2',
      [round, matchId]
    );
  },

  // ── Settlement ──────────────────────────────────────────────────────────

  /**
   * Finalise a match: write winner, update participant Elo, compute new Elo ratings.
   * All writes happen in a single transaction.
   *
   * @param {object} match      - Match instance
   * @param {string} winnerId   - agentId of winner (or null for draws)
   * @param {string} reason     - 'control' | 'home_captured' | 'forfeit' | 'draw_*'
   */
  async settle(match, winnerId, reason) {
    await transaction(async (client) => {
      // Mark match finished
      await client.query(
        `UPDATE matches
            SET status = 'finished',
                winner_id = $1,
                win_reason = $2,
                finished_at = NOW()
          WHERE match_id = $3`,
        [winnerId, reason, match.matchId]
      );

      // Compute and write Elo updates for all participants
      const participants = match.agentSlots.map((s, idx) => ({
        agentId:    s.agentId,
        playerSlot: ['p1', 'p2', 'p3', 'p4'][idx],
        isWinner:   s.agentId === winnerId,
      }));

      for (const p of participants) {
        // Fetch current Elo + tier to determine K-factor
        const agentRes = await client.query(
          'SELECT elo, tier FROM agents WHERE agent_id = $1',
          [p.agentId]
        );
        if (!agentRes.rows.length) continue;

        const { elo: currentElo, tier } = agentRes.rows[0];
        const K = tier === 1 && currentElo < 1300 ? 40 : 20;

        // Simple 1v1 Elo (for N-player, use expected score against field)
        const opponent  = participants.find(x => x.agentId !== p.agentId);
        let   newElo    = currentElo;

        if (opponent) {
          const oppRes = await client.query(
            'SELECT elo FROM agents WHERE agent_id = $1',
            [opponent.agentId]
          );
          const oppElo  = oppRes.rows[0]?.elo ?? 1000;
          const expected = 1 / (1 + Math.pow(10, (oppElo - currentElo) / 400));
          const actual   = p.isWinner ? 1 : (reason.startsWith('draw') ? 0.5 : 0);
          newElo = Math.round(currentElo + K * (actual - expected));
          newElo = Math.max(100, newElo); // floor at 100
        }

        const isWin  = p.isWinner ? 1 : 0;
        const isLoss = !p.isWinner && !reason.startsWith('draw') ? 1 : 0;
        const isDraw = reason.startsWith('draw') ? 1 : 0;

        // Update agent stats
        await client.query(
          `UPDATE agents
              SET elo    = $1,
                  wins   = wins   + $2,
                  losses = losses + $3,
                  draws  = draws  + $4
            WHERE agent_id = $5`,
          [newElo, isWin, isLoss, isDraw, p.agentId]
        );

        // Write Elo outcome to match_participants
        await client.query(
          `UPDATE match_participants SET elo_after = $1 WHERE match_id = $2 AND agent_id = $3`,
          [newElo, match.matchId, p.agentId]
        );

        // Mark queue entry as matched (cleanup)
        await client.query(
          `UPDATE queue_entries SET match_id = $1 WHERE agent_id = $2 AND match_id IS NULL`,
          [match.matchId, p.agentId]
        );
      }
    });

    // Clean up Redis hot-path keys
    await redisMatchState.del(match.matchId);
  },

  // ── Void ────────────────────────────────────────────────────────────────

  async voidMatch(matchId, reason) {
    await query(
      `UPDATE matches SET status = 'aborted', win_reason = $1, finished_at = NOW() WHERE match_id = $2`,
      [reason, matchId]
    );
    await redisMatchState.del(matchId);
  },

  // ── Read helpers (for HTTP routes) ─────────────────────────────────────

  async getMatch(matchId) {
    const { rows } = await query(
      `SELECT m.*, json_agg(mp.* ORDER BY mp.player_slot) AS participants
         FROM matches m
         LEFT JOIN match_participants mp USING (match_id)
        WHERE m.match_id = $1
        GROUP BY m.match_id`,
      [matchId]
    );
    return rows[0] ?? null;
  },

  async getMatchLog(matchId) {
    const { rows } = await query(
      `SELECT seq, event_type, payload, prev_hash, entry_hash, created_at
         FROM match_log
        WHERE match_id = $1
        ORDER BY seq ASC`,
      [matchId]
    );
    return rows;
  },

  async listActive() {
    const { rows } = await query(
      `SELECT m.match_id, m.mode, m.tier, m.status, m.round,
              json_agg(mp.agent_id) AS agent_ids
         FROM matches m
         LEFT JOIN match_participants mp USING (match_id)
        WHERE m.status IN ('lobby','active')
        GROUP BY m.match_id
        ORDER BY m.created_at DESC
        LIMIT 100`
    );
    return rows;
  },

  async getLeaderboard(tier = null, limit = 100) {
    const { rows } = await query(
      tier
        ? `SELECT * FROM leaderboard WHERE tier = $1 ORDER BY rank_in_tier LIMIT $2`
        : `SELECT * FROM leaderboard ORDER BY rank_global LIMIT $1`,
      tier ? [tier, limit] : [limit]
    );
    return rows;
  },
};

// ── Cell encoder ──────────────────────────────────────────────────────────────

/**
 * Encode a 2D cells array into compact binary for board_snapshots.
 * 1 byte per cell:
 *   bits 7-6: owner index (0=neutral,1=p1,2=p2,3=p3/p4)
 *   bits 5-4: defenceLevel (0-3)
 *   bit  3:   isHome flag
 */
function encodeCells(cells, size) {
  const buf = Buffer.alloc(size * size);
  let i = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell    = cells[r][c];
      const ownerIdx = cell.owner ? (parseInt(cell.owner.slice(-1), 10) % 4) : 0;
      buf[i++] = (ownerIdx << 6) | ((cell.defenceLevel & 0x3) << 4) | (cell.isHome ? 0x8 : 0);
    }
  }
  return buf;
}
