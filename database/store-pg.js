/**
 * services/arena-identity/store-pg.js
 *
 * Drop-in replacement for store.js — same exported interface, backed by
 * PostgreSQL (agents table) and Redis (nonces, profile cache).
 *
 * Swap in app.js and routes with:
 *   import { agentStore, nonceStore } from '../../services/arena-identity/store-pg.js';
 *
 * No route changes needed — the interface is identical.
 */

import { randomBytes } from 'crypto';
import { query, transaction } from '../../db/pool.js';
import { profileCache } from '../../db/redis.js';

// ── Agent Store ───────────────────────────────────────────────────────────────

export const agentStore = {
  /**
   * Create a new agent. Throws if DID or publicKey already registered.
   * @param {object} record  - { did, publicKey, displayName, agentType, linkedWallet? }
   * @returns {AgentRecord}
   */
  async create(record) {
    const { did, publicKey, displayName, agentType = 'standard', linkedWallet = null } = record;

    const { rows } = await query(
      `INSERT INTO agents (did, public_key, display_name, agent_type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [did, publicKey, displayName, agentType]
    );

    const agent = rowToRecord(rows[0]);
    await profileCache.set(agent.agentId, agent);
    return agent;
  },

  /**
   * Look up an agent by DID.
   * Checks Redis cache first; falls back to PostgreSQL.
   */
  async getByDid(did) {
    // No cache by DID — do a direct PG lookup (DID has an index)
    const { rows } = await query(
      'SELECT * FROM agents WHERE did = $1',
      [did]
    );
    if (!rows.length) return null;
    const agent = rowToRecord(rows[0]);
    await profileCache.set(agent.agentId, agent);
    return agent;
  },

  /**
   * Look up an agent by UUID.
   * Checks Redis cache first.
   */
  async getById(agentId) {
    const cached = await profileCache.get(agentId);
    if (cached) return cached;

    const { rows } = await query(
      'SELECT * FROM agents WHERE agent_id = $1',
      [agentId]
    );
    if (!rows.length) return null;
    const agent = rowToRecord(rows[0]);
    await profileCache.set(agentId, agent);
    return agent;
  },

  /**
   * Update mutable fields on an agent (displayName, agentType).
   * DID and publicKey are immutable.
   */
  async update(did, patch) {
    const allowed = ['display_name', 'agent_type'];
    const columnMap = { displayName: 'display_name', agentType: 'agent_type' };

    const setClauses = [];
    const values     = [];

    for (const [jsKey, pgCol] of Object.entries(columnMap)) {
      if (patch[jsKey] !== undefined) {
        values.push(patch[jsKey]);
        setClauses.push(`${pgCol} = $${values.length}`);
      }
    }

    if (!setClauses.length) throw new Error('No updatable fields provided');

    values.push(did);
    const { rows } = await query(
      `UPDATE agents SET ${setClauses.join(', ')} WHERE did = $${values.length} RETURNING *`,
      values
    );
    if (!rows.length) throw new Error('Agent not found');

    const agent = rowToRecord(rows[0]);
    await profileCache.del(agent.agentId); // bust cache
    await profileCache.set(agent.agentId, agent);
    return agent;
  },

  /**
   * Bump last_active timestamp (called after successful auth).
   */
  async touch(agentId) {
    await query(
      'UPDATE agents SET updated_at = NOW() WHERE agent_id = $1',
      [agentId]
    );
    await profileCache.del(agentId);
  },

  /**
   * Update Elo + win/loss/draw stats atomically (called post-match).
   */
  async updateStats(agentId, { elo, wins, losses, draws }) {
    const { rows } = await query(
      `UPDATE agents
          SET elo = $1,
              wins   = wins   + $2,
              losses = losses + $3,
              draws  = draws  + $4
        WHERE agent_id = $5
        RETURNING *`,
      [elo, wins ?? 0, losses ?? 0, draws ?? 0, agentId]
    );
    if (!rows.length) throw new Error('Agent not found');
    const agent = rowToRecord(rows[0]);
    await profileCache.del(agentId);
    return agent;
  },

  async list() {
    const { rows } = await query('SELECT * FROM agents ORDER BY created_at DESC');
    return rows.map(rowToRecord);
  },

  async count() {
    const { rows } = await query('SELECT COUNT(*) AS n FROM agents');
    return parseInt(rows[0].n, 10);
  },
};

// ── Nonce Store ───────────────────────────────────────────────────────────────

/**
 * Uses PostgreSQL's consume_nonce() stored function for atomic single-use
 * nonce validation (no TOCTOU race). Nonce TTL is 5 minutes (set in SQL).
 */
export const nonceStore = {
  /**
   * Store a new nonce for a DID.
   * Replaces any existing pending nonce for that DID (one at a time).
   */
  async set(nonce, did, _expiresAt) {
    // Delete any existing nonces for this DID first
    await query('DELETE FROM auth_nonces WHERE did = $1', [did]);

    await query(
      `INSERT INTO auth_nonces (nonce, did) VALUES ($1, $2)`,
      [nonce, did]
    );
  },

  /**
   * Consume a nonce atomically. Returns the DID it was issued for,
   * or null if invalid / expired / already used.
   */
  async consume(nonce) {
    // We need the DID to call consume_nonce, so we read it first
    const peek = await query(
      'SELECT did FROM auth_nonces WHERE nonce = $1',
      [nonce]
    );
    if (!peek.rows.length) return null;

    const did = peek.rows[0].did;
    const { rows } = await query(
      'SELECT ok, reason FROM consume_nonce($1, $2)',
      [nonce, did]
    );

    if (!rows[0]?.ok) return null;
    return did;
  },

  /**
   * Purge expired nonces (pg_cron handles this in production,
   * but expose a manual trigger for tests / startup).
   */
  async purgeExpired() {
    const { rowCount } = await query(
      `DELETE FROM auth_nonces WHERE expires_at < NOW()`
    );
    return rowCount;
  },
};

// ── Row → Record mapper ───────────────────────────────────────────────────────

function rowToRecord(row) {
  return {
    agentId:         row.agent_id,
    did:             row.did,
    publicKey:       row.public_key,
    displayName:     row.display_name,
    agentType:       row.agent_type,
    tier:            row.tier,
    elo:             row.elo,
    wins:            row.wins,
    losses:          row.losses,
    draws:           row.draws,
    creditBalance:   row.credit_balance ?? 0,
    disconnectCount: row.disconnect_count ?? 0,
    matchCount:      row.match_count ?? 0,
    createdAt:       row.created_at,
    lastSeenAt:      row.updated_at,
  };
}
