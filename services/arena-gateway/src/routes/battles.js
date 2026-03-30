/**
 * services/arena-gateway/src/routes/battles.js
 * GET /api/battles        — list matches
 * GET /api/battles/:id    — detailed match state
 */

const express = require('express');
const { query } = require('../database');

const router = express.Router();

/**
 * GET /api/battles
 * Query params:
 *   status   (active | completed | queued | all)  default: all
 *   limit    default 20, max 100
 *   agent_id (optional UUID filter)
 */
router.get('/', async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit ?? 20, 10), 100);
    const status  = req.query.status ?? 'all';
    const agentId = req.query.agent_id ?? null;

    // Map friendly status names to DB enum values
    const statusMap = {
      active:    ['active'],
      queued:    ['lobby'],
      completed: ['finished', 'aborted'],
      all:       ['lobby', 'active', 'finished', 'aborted'],
    };
    const statuses = statusMap[status] ?? statusMap.all;

    const params = [statuses, limit];
    let agentFilter = '';
    if (agentId) {
      params.push(agentId);
      agentFilter = `AND EXISTS (
        SELECT 1 FROM match_participants mp2
        WHERE mp2.match_id = m.match_id AND mp2.agent_id = $${params.length}
      )`;
    }

    const sql = `
      SELECT
        m.match_id,
        m.mode,
        m.tier,
        m.status,
        m.round          AS current_round,
        m.board_size,
        m.win_reason,
        m.created_at,
        m.started_at,
        m.finished_at,
        m.winner_id,
        -- Aggregate participants
        json_agg(
          json_build_object(
            'agent_id',   a.agent_id,
            'name',       a.display_name,
            'elo',        mp.elo_before,
            'elo_after',  mp.elo_after,
            'slot',       mp.player_slot
          ) ORDER BY mp.player_slot
        ) AS participants
      FROM matches m
      JOIN match_participants mp ON mp.match_id = m.match_id
      JOIN agents a              ON a.agent_id  = mp.agent_id
      WHERE m.status = ANY($1::match_status[])
      ${agentFilter}
      GROUP BY m.match_id
      ORDER BY
        CASE m.status WHEN 'active' THEN 0 WHEN 'lobby' THEN 1 ELSE 2 END,
        m.created_at DESC
      LIMIT $2
    `;

    const { rows } = await query(sql, params);

    // Shape participants into agent1/agent2 for convenience
    const battles = rows.map(row => {
      const p = row.participants ?? [];
      return {
        match_id:      row.match_id,
        status:        row.status,
        mode:          row.mode,
        tier:          row.tier,
        board_size:    row.board_size,
        current_round: row.current_round,
        win_reason:    row.win_reason,
        winner_id:     row.winner_id,
        agent1:        p[0] ?? null,
        agent2:        p[1] ?? null,
        extra_agents:  p.slice(2),
        started_at:    row.started_at,
        finished_at:   row.finished_at,
        created_at:    row.created_at,
      };
    });

    // Count total matching (without LIMIT)
    const countSql = `
      SELECT COUNT(DISTINCT m.match_id)
      FROM matches m
      ${agentId ? 'JOIN match_participants mp ON mp.match_id = m.match_id' : ''}
      WHERE m.status = ANY($1::match_status[])
      ${agentId ? `AND mp.agent_id = $2` : ''}
    `;
    const countParams = agentId ? [statuses, agentId] : [statuses];
    const countResult = await query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count, 10);

    return res.json({ battles, total });
  } catch (err) {
    console.error('[battles] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch battles' });
  }
});

/**
 * GET /api/battles/:matchId
 * Full match detail including log entries and latest board snapshot.
 */
router.get('/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    // UUID format guard
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(matchId)) {
      return res.status(400).json({ error: 'Invalid match ID format' });
    }

    const [matchResult, logResult, snapshotResult] = await Promise.all([
      query(
        `SELECT
           m.*,
           json_agg(
             json_build_object(
               'agent_id',   a.agent_id,
               'name',       a.display_name,
               'elo_before', mp.elo_before,
               'elo_after',  mp.elo_after,
               'slot',       mp.player_slot,
               'home_row',   mp.home_row,
               'home_col',   mp.home_col
             ) ORDER BY mp.player_slot
           ) AS participants
         FROM matches m
         JOIN match_participants mp ON mp.match_id = m.match_id
         JOIN agents a              ON a.agent_id  = mp.agent_id
         WHERE m.match_id = $1
         GROUP BY m.match_id`,
        [matchId]
      ),
      query(
        `SELECT seq, event_type, payload, prev_hash, entry_hash, created_at
         FROM match_log WHERE match_id = $1 ORDER BY seq ASC LIMIT 500`,
        [matchId]
      ),
      query(
        `SELECT round, created_at
         FROM board_snapshots
         WHERE match_id = $1
         ORDER BY round DESC LIMIT 1`,
        [matchId]
      ),
    ]);

    if (!matchResult.rows.length) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const match = matchResult.rows[0];

    return res.json({
      match_id:        match.match_id,
      mode:            match.mode,
      tier:            match.tier,
      board_size:      match.board_size,
      status:          match.status,
      current_round:   match.round,
      win_reason:      match.win_reason,
      winner_id:       match.winner_id,
      participants:    match.participants,
      started_at:      match.started_at,
      finished_at:     match.finished_at,
      created_at:      match.created_at,
      latest_snapshot: snapshotResult.rows[0] ?? null,
      log_entries:     logResult.rows,
      log_length:      logResult.rows.length,
    });
  } catch (err) {
    console.error('[battles] Detail error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch battle details' });
  }
});

module.exports = router;
