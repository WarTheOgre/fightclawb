/**
 * services/arena-gateway/src/routes/leaderboard.js
 * GET /api/leaderboard — ranked agent list from the materialized view.
 */

const express = require('express');
const { query } = require('../database');

const router = express.Router();

/**
 * GET /api/leaderboard
 * Query params:
 *   limit    (default 50, max 100)
 *   offset   (default 0)
 *   tier     (optional: 1 | 2)
 */
router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  ?? 50,  10), 100);
    const offset = Math.max(parseInt(req.query.offset ?? 0,   10), 0);
    const tier   = req.query.tier ? parseInt(req.query.tier, 10) : null;

    if (isNaN(limit) || isNaN(offset)) {
      return res.status(400).json({ error: 'Invalid pagination parameters' });
    }

    // Build query — use the materialized view when populated, fall back to agents table
    let sql, params;
    if (tier) {
      sql = `
        SELECT
          rank_in_tier            AS rank,
          rank_global,
          agent_id,
          display_name,
          did,
          tier,
          elo,
          wins,
          losses,
          draws,
          games_played,
          win_pct                 AS win_rate
        FROM leaderboard
        WHERE tier = $1
        ORDER BY rank_in_tier
        LIMIT $2 OFFSET $3
      `;
      params = [tier, limit, offset];
    } else {
      sql = `
        SELECT
          rank_global             AS rank,
          rank_global,
          agent_id,
          display_name,
          did,
          tier,
          elo,
          wins,
          losses,
          draws,
          games_played,
          win_pct                 AS win_rate
        FROM leaderboard
        ORDER BY rank_global
        LIMIT $1 OFFSET $2
      `;
      params = [limit, offset];
    }

    const [rowsResult, countResult] = await Promise.all([
      query(sql, params),
      query(
        tier
          ? 'SELECT COUNT(*) FROM leaderboard WHERE tier = $1'
          : 'SELECT COUNT(*) FROM leaderboard',
        tier ? [tier] : []
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    const page  = Math.floor(offset / limit) + 1;

    return res.json({
      agents: rowsResult.rows,
      total,
      page,
      limit: limit,
      offset: offset,
      count: total,
    });
  } catch (err) {
    // Materialized view may not exist yet — fall back to agents table
    if (err.message?.includes('leaderboard') && err.message?.includes('does not exist')) {
      return fallbackLeaderboard(req, res);
    }
    console.error('[leaderboard] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

/** Fallback: query agents table directly (no materialized view). */
async function fallbackLeaderboard(req, res) {
  try {
    const limit  = Math.min(parseInt(req.query.limit ?? 50, 10), 100);
    const offset = Math.max(parseInt(req.query.offset ?? 0, 10), 0);

    const sql = `
      SELECT
        ROW_NUMBER() OVER (ORDER BY elo DESC)   AS rank,
        agent_id,
        display_name,
        did,
        tier,
        elo,
        wins,
        losses,
        draws,
        (wins + losses + draws)                 AS games_played,
        CASE WHEN (wins + losses + draws) > 0
             THEN ROUND(wins::NUMERIC / (wins + losses + draws) * 100, 1)
             ELSE 0
        END                                     AS win_rate,
        updated_at     AS last_match_at
      FROM agents
      ORDER BY elo DESC
      LIMIT $1 OFFSET $2
    `;

    const [rows, count] = await Promise.all([
      query(sql, [limit, offset]),
      query('SELECT COUNT(*) FROM agents', []),
    ]);

    return res.json({
      agents: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      limit: limit,
      offset: offset,
      limit: limit,
      offset: offset,
      count: total,
    });
  } catch (err) {
    console.error('[leaderboard fallback] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
}

/**
 * GET /api/leaderboard/refresh
 * Trigger a manual leaderboard materialized view refresh (admin use).
 */
router.post('/refresh', async (req, res) => {
  try {
    await query('REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard', []);
    return res.json({ ok: true, refreshed_at: new Date().toISOString() });
  } catch (err) {
    console.error('[leaderboard] Refresh error:', err.message);
    return res.status(500).json({ error: 'Refresh failed' });
  }
});

module.exports = router;
