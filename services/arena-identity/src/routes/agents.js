/**
 * services/arena-identity/src/routes/agents.js
 * POST /api/auth/register  — register a new agent
 * GET  /api/agents/:id     — public agent profile
 * GET  /api/agents         — list agents (paginated)
 */

const express = require('express');
const { randomBytes, createHash } = require('crypto');
const { Pool } = require('pg');

const router = express.Router();

// Inline pool (identity service has its own connection)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/fightclawb',
  max: 10,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,
});

async function dbQuery(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('[identity/db]', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateApiKey() {
  return randomBytes(32).toString('hex');
}

/** Derive a deterministic did:key string from a hex public key. */
function pubkeyToDid(pubKeyHex) {
  // Simplified did:key derivation — in production use the full multibase encoding.
  const hash = createHash('sha256').update(pubKeyHex).digest('hex').slice(0, 32);
  return `did:key:z6Mk${hash}`;
}

function isValidDisplayName(name) {
  return typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 64;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simplified registration that doesn't require a pre-generated keypair.
 * Generates a server-side placeholder public key and DID for quick onboarding.
 * Production flow: client generates Ed25519 keypair and sends publicKey + did.
 */
router.post('/auth/register', async (req, res) => {
  try {
    const {
      name,
      description,
      contact_email,
      repository_url,
      // Optional: client-supplied keypair fields
      publicKey,
      did: suppliedDid,
      agent_type = 'standard',
    } = req.body;

    if (!isValidDisplayName(name)) {
      return res.status(400).json({
        error: 'name is required and must be 2–64 characters',
      });
    }

    const validTypes = ['standard', 'code-bot', 'webhook'];
    if (!validTypes.includes(agent_type)) {
      return res.status(400).json({
        error: `agent_type must be one of: ${validTypes.join(', ')}`,
      });
    }

    // If client didn't supply a keypair, generate placeholders
    const resolvedPubKey = publicKey ?? randomBytes(32).toString('hex');
    const resolvedDid    = suppliedDid ?? pubkeyToDid(resolvedPubKey);

    // Check for duplicate DID or public key
    const dupCheck = await dbQuery(
      'SELECT agent_id FROM agents WHERE did = $1 OR public_key = $2',
      [resolvedDid, resolvedPubKey]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Agent with this DID or public key already exists' });
    }

    // Insert agent
    const { rows } = await dbQuery(
      `INSERT INTO agents (did, public_key, display_name, agent_type, tier, elo)
       VALUES ($1, $2, $3, $4, 1, 800)
       RETURNING agent_id, did, display_name, agent_type, tier, elo, created_at`,
      [resolvedDid, resolvedPubKey, name.trim(), agent_type]
    );

    const agent = rows[0];

    // Generate an API key (stored hashed in production — returned once here)
    const apiKey = generateApiKey();

    // In production: store hash of apiKey in a separate api_keys table.
    // For now we return it directly; caller must save it.

    return res.status(201).json({
      agent_id:   agent.agent_id,
      did:        agent.did,
      name:       agent.display_name,
      agent_type: agent.agent_type,
      tier:       agent.tier,
      elo:        agent.elo,
      api_key:    apiKey,
      created_at: agent.created_at,
      status:     'active',
      note:       'Save your api_key — it is not stored and cannot be recovered.',
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Agent with this DID already exists' });
    }
    console.error('[register] Error:', err.message);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/agents/:agentId
// ─────────────────────────────────────────────────────────────────────────────

router.get('/agents/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID format' });
    }

    const agentResult = await dbQuery(
      `SELECT agent_id, did, display_name, agent_type, tier, elo,
              wins, losses, draws,
              (wins + losses + draws) AS games_played,
              CASE WHEN (wins + losses + draws) > 0
                   THEN ROUND(wins::NUMERIC / (wins + losses + draws) * 100, 1)
                   ELSE 0 END         AS win_rate,
              created_at, updated_at
       FROM agents WHERE agent_id = $1`,
      [agentId]
    );

    if (!agentResult.rows.length) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Fetch last 10 matches
    const matchResult = await dbQuery(
      `SELECT m.match_id, m.mode, m.status, m.round, m.win_reason,
              m.started_at, m.finished_at,
              mp.elo_before, mp.elo_after, mp.player_slot,
              CASE WHEN m.winner_id = $1 THEN 'win'
                   WHEN m.status = 'finished' THEN 'loss'
                   ELSE m.status::text END AS result
       FROM matches m
       JOIN match_participants mp ON mp.match_id = m.match_id AND mp.agent_id = $1
       ORDER BY m.created_at DESC
       LIMIT 10`,
      [agentId]
    );

    const agent = agentResult.rows[0];
    return res.json({
      agent_id:     agent.agent_id,
      did:          agent.did,
      name:         agent.display_name,
      agent_type:   agent.agent_type,
      tier:         agent.tier,
      elo:          agent.elo,
      wins:         agent.wins,
      losses:       agent.losses,
      draws:        agent.draws,
      games_played: agent.games_played,
      win_rate:     agent.win_rate,
      recent_matches: matchResult.rows,
      created_at:   agent.created_at,
      updated_at:   agent.updated_at,
    });
  } catch (err) {
    console.error('[agents/:id] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/agents  — paginated list
// ─────────────────────────────────────────────────────────────────────────────

router.get('/agents', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit ?? 20, 10), 100);
    const offset = Math.max(parseInt(req.query.offset ?? 0,  10), 0);

    const [rows, count] = await Promise.all([
      dbQuery(
        `SELECT agent_id, did, display_name AS name, agent_type, tier, elo,
                wins, losses, draws, created_at
         FROM agents ORDER BY elo DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      dbQuery('SELECT COUNT(*) FROM agents', []),
    ]);

    return res.json({
      agents:   rows.rows,
      total:    parseInt(count.rows[0].count, 10),
      page:     Math.floor(offset / limit) + 1,
      per_page: limit,
    });
  } catch (err) {
    console.error('[agents list] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

module.exports = router;
