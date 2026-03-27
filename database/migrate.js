#!/usr/bin/env node
/**
 * scripts/migrate.js — Database migration runner
 *
 * Usage:
 *   node scripts/migrate.js            # apply all pending migrations
 *   node scripts/migrate.js --status   # show applied/pending state
 *   node scripts/migrate.js --rollback # not implemented (see note)
 *
 * Migration files live in migrations/NNN_description.sql
 * Applied versions tracked in the schema_migrations table.
 *
 * Note: Destructive rollbacks are intentionally not automated.
 * Write a new forward migration to undo changes (safer in production).
 */

import 'dotenv/config';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

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

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--status')) {
  await showStatus();
} else {
  await runMigrations();
}
