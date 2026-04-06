// services/arena-identity/src/routes/credentials.js
// Verifiable Credential issuance and verification endpoints
//
// POST /api/credentials/issue   — Issue a signed VC for an agent
// POST /api/credentials/verify  — Verify a VC signed by FightClawb

const express = require('express');
const { Pool } = require('pg');
const {
  ISSUER_DID,
  buildCredential,
  signCredential,
  verifyCredential,
} = require('../utils/did');

const router = express.Router();

// ── Database ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:password@localhost:5432/fightclawb',
  max: 5,
  idleTimeoutMillis: 30000,
  statement_timeout: 15000,
});

async function dbQuery(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('[credentials/db]', err.message);
    throw err;
  }
}

// ── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── POST /issue ──────────────────────────────────────────────────────────────

router.post('/issue', async (req, res) => {
  try {
    const { agent_id } = req.body;

    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required' });
    }
    if (!UUID_RE.test(agent_id)) {
      return res.status(400).json({ error: 'agent_id must be a valid UUID' });
    }

    // 1. Fetch agent data
    const agentResult = await dbQuery(
      `SELECT agent_id, did, display_name, agent_type, tier, elo,
              wins, losses, draws, created_at
       FROM agents
       WHERE agent_id = $1`,
      [agent_id]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = agentResult.rows[0];

    // 2. Compute derived stats
    const totalMatches = (agent.wins || 0) + (agent.losses || 0) + (agent.draws || 0);
    const winRate = totalMatches > 0
      ? Math.round((agent.wins / totalMatches) * 10000) / 10000
      : 0;

    // 3. Find peak ELO from match history
    const peakResult = await dbQuery(
      `SELECT GREATEST(
          COALESCE(MAX(elo_before), 0),
          COALESCE(MAX(elo_after), 0)
       ) AS peak_elo
       FROM match_participants
       WHERE agent_id = $1`,
      [agent_id]
    );
    const peakElo = Math.max(
      peakResult.rows[0]?.peak_elo || 0,
      agent.elo || 800
    );

    // 4. Build and sign credential
    const credential = buildCredential(agent, { peakElo, winRate, totalMatches });
    const signedCredential = signCredential(credential);

    console.log(`[credentials] Issued VC for agent ${agent_id} (${agent.display_name})`);

    res.json(signedCredential);
  } catch (err) {
    console.error('[credentials/issue]', err);
    res.status(500).json({ error: 'Failed to issue credential' });
  }
});

// ── POST /verify ─────────────────────────────────────────────────────────────

router.post('/verify', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'credential object is required' });
    }

    if (!credential.proof) {
      return res.status(400).json({ error: 'credential has no proof block' });
    }

    // Check issuer
    if (credential.issuer !== ISSUER_DID) {
      return res.status(400).json({
        verified: false,
        error: `Unknown issuer: ${credential.issuer}. This endpoint only verifies credentials issued by ${ISSUER_DID}`
      });
    }

    const result = verifyCredential(credential);

    if (result.verified) {
      res.json({
        verified: true,
        issuer: credential.issuer,
        credentialSubject: credential.credentialSubject,
        issuanceDate: credential.issuanceDate,
        verifiedAt: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        verified: false,
        error: result.error
      });
    }
  } catch (err) {
    console.error('[credentials/verify]', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

module.exports = router;
