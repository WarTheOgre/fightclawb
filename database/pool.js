/**
 * db/pool.js — PostgreSQL connection pool
 *
 * Wraps pg.Pool with:
 *  - Health tracking  (pool.healthy flag)
 *  - Automatic reconnect on idle-client errors
 *  - Typed query helper with statement timeout
 *  - Transaction helper
 *
 * Usage:
 *   import { query, transaction, pool } from '../../db/pool.js';
 *   const { rows } = await query('SELECT * FROM agents WHERE did = $1', [did]);
 */

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// ── Pool configuration ───────────────────────────────────────────────────────

const poolConfig = {
  host:               process.env.PGHOST     ?? 'localhost',
  port:               parseInt(process.env.PGPORT ?? '5432', 10),
  database:           process.env.PGDATABASE ?? 'arena',
  user:               process.env.PGUSER     ?? 'arena',
  password:           process.env.PGPASSWORD,
  max:                parseInt(process.env.PG_POOL_MAX ?? '20', 10),
  idleTimeoutMillis:  30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout:  parseInt(process.env.PG_STATEMENT_TIMEOUT ?? '10000', 10),
};

export const pool = new Pool(poolConfig);

// ── Health tracking ──────────────────────────────────────────────────────────

pool.healthy = false;

pool.on('connect', () => {
  pool.healthy = true;
});

pool.on('error', (err) => {
  console.error('[pg] Pool error:', err.message);
  // Don't set healthy = false here — a single client error doesn't mean
  // the pool is down. Let query() surface 503s on actual failures.
});

// ── Initialise (ping on startup) ─────────────────────────────────────────────

export async function initDb() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    pool.healthy = true;
    console.log('[pg] Connected to PostgreSQL');
    return true;
  } catch (err) {
    console.error('[pg] Could not connect to PostgreSQL:', err.message);
    pool.healthy = false;
    return false;
  }
}

// ── Query helper ─────────────────────────────────────────────────────────────

/**
 * Run a parameterised query against the pool.
 * @param {string}   text    SQL string with $1, $2 … placeholders
 * @param {any[]}    [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms  = Date.now() - start;
    if (ms > 500) console.warn(`[pg] Slow query (${ms}ms):`, text.slice(0, 80));
    return res;
  } catch (err) {
    console.error('[pg] Query error:', err.message, '\nSQL:', text.slice(0, 120));
    throw err;
  }
}

// ── Transaction helper ───────────────────────────────────────────────────────

/**
 * Run multiple queries inside a single transaction.
 * Automatically commits on success, rolls back on error.
 *
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 *
 * @example
 *   const result = await transaction(async (client) => {
 *     await client.query('UPDATE agents SET elo=$1 WHERE agent_id=$2', [elo, id]);
 *     await client.query('INSERT INTO match_participants …');
 *     return { ok: true };
 *   });
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

export async function closeDb() {
  await pool.end();
  console.log('[pg] Pool closed');
}

process.on('SIGTERM', closeDb);
process.on('SIGINT',  closeDb);
