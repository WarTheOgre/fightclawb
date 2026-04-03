#!/usr/bin/env node
/**
 * scripts/migrate.js — Database migration runner
 *
 * Usage:
 *   node database/migrate.js              # apply all pending migrations
 *   node database/migrate.js --status    # show applied/pending state
 *   node database/migrate.js --rollback  # remove last applied migration & drop its objects
 *   node database/migrate.js --reset     # drop all tables and re-run all migrations
 *
 * Migration files live in database/migrations/NNN_description.sql
 * Rollback files live alongside as NNN_description.rollback.sql
 * Applied versions tracked in the schema_migrations table.
 */

import 'dotenv/config';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

const { Client } = pg;

async function getClient() {
  const client = new Client({
    host:     process.env.PGHOST     ?? 'localhost',
    port:     parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'arena',
    user:     process.env.PGUSER     ?? 'arena',
    password: process.env.PGPASSWORD,
  });
  await client.connect();
  return client;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map(r => r.version));
}

async function getMigrationFiles() {
  let files;
  try {
    files = await readdir(MIGRATIONS_DIR);
  } catch {
    console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  return files
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => ({ version: f.replace('.sql', ''), file: join(MIGRATIONS_DIR, f) }));
}

async function runMigrations() {
  const client = await getClient();

  try {
    await ensureMigrationsTable(client);
    const applied     = await getApplied(client);
    const allMigs     = await getMigrationFiles();
    const pending     = allMigs.filter(m => !applied.has(m.version));

    if (pending.length === 0) {
      console.log('✓ All migrations are up to date.');
      return;
    }

    console.log(`Applying ${pending.length} pending migration(s)…\n`);

    for (const { version, file } of pending) {
      console.log(`  → ${version}`);
      const sql = await readFile(file, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        console.log(`    ✓ Applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    ✗ Failed: ${err.message}`);
        process.exit(1);
      }
    }

    console.log('\n✓ Migrations complete.');
  } finally {
    await client.end();
  }
}

async function showStatus() {
  const client = await getClient();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const all     = await getMigrationFiles();

    console.log('\nMigration status:\n');
    for (const { version } of all) {
      const mark = applied.has(version) ? '✓' : '○';
      console.log(`  ${mark} ${version}`);
    }
    console.log(`\n${applied.size} of ${all.length} applied.\n`);
  } finally {
    await client.end();
  }
}

// ── Rollback ─────────────────────────────────────────────────────────────────

async function rollbackLast() {
  const client = await getClient();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);

    if (applied.size === 0) {
      console.log('Nothing to roll back — no migrations applied.');
      return;
    }

    const lastVersion = [...applied].sort().pop();
    const rollbackFile = join(MIGRATIONS_DIR, `${lastVersion}.rollback.sql`);

    let sql;
    try {
      sql = await readFile(rollbackFile, 'utf8');
    } catch {
      console.error(`Rollback file not found: ${rollbackFile}`);
      console.error('Create it with the SQL needed to undo this migration.');
      process.exit(1);
    }

    console.log(`Rolling back ${lastVersion}…`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [lastVersion]);
      await client.query('COMMIT');
      console.log(`  ✓ Rolled back`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ Failed: ${err.message}`);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

// ── Reset ────────────────────────────────────────────────────────────────────

async function resetAll() {
  const client = await getClient();
  try {
    console.log('Dropping all tables and views…\n');
    await client.query(`
      DROP MATERIALIZED VIEW IF EXISTS leaderboard CASCADE;
      DROP TABLE IF EXISTS
        match_log, round_actions, board_snapshots,
        match_participants, sandbox_jobs, queue_entries,
        matches, auth_nonces, agents, schema_migrations
      CASCADE;
      DROP TYPE IF EXISTS match_status CASCADE;
      DROP TYPE IF EXISTS job_status CASCADE;
      DROP FUNCTION IF EXISTS touch_updated_at CASCADE;
      DROP FUNCTION IF EXISTS consume_nonce CASCADE;
      DROP FUNCTION IF EXISTS append_log_entry CASCADE;
    `);
    console.log('  ✓ Dropped\n');
  } finally {
    await client.end();
  }

  // Re-run all migrations with a fresh connection
  await runMigrations();
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--status')) {
  await showStatus();
} else if (args.includes('--rollback')) {
  await rollbackLast();
} else if (args.includes('--reset')) {
  await resetAll();
} else {
  await runMigrations();
}
