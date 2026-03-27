#!/usr/bin/env bash
# scripts/migrate.sh — Run pending database migrations
#
# Usage: migrate.sh [env_file]
#        migrate.sh /opt/fight-clawb/.env
#
# Reads connection params from environment or env file.
# Tracks applied migrations in schema_migrations table.
# Safe to run multiple times — skips already-applied files.

set -euo pipefail

ENV_FILE="${1:-/opt/fight-clawb/.env}"
MIGRATIONS_DIR="$(dirname "$0")/../migrations"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[migrate]${NC} $*"; }
warn() { echo -e "${YELLOW}[migrate]${NC} $*"; }
err()  { echo -e "${RED}[migrate]${NC} $*" >&2; }

# ─── Load env ─────────────────────────────────────────────────────────────────
if [[ -f "${ENV_FILE}" ]]; then
  set -o allexport
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +o allexport
fi

# Parse DATABASE_URL if individual vars aren't set
if [[ -n "${DATABASE_URL:-}" ]]; then
  # postgresql://user:pass@host:port/db
  PGUSER=$(echo "$DATABASE_URL" | sed -E 's|postgresql://([^:]+).*|\1|')
  PGPASSWORD=$(echo "$DATABASE_URL" | sed -E 's|postgresql://[^:]+:([^@]+).*|\1|')
  PGHOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:/]+).*|\1|')
  PGPORT=$(echo "$DATABASE_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
  PGDATABASE=$(echo "$DATABASE_URL" | sed -E 's|.*/([^?]+).*|\1|')
fi

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-arena}"
export PGUSER="${PGUSER:-arena}"
export PGPASSWORD="${PGPASSWORD}"

log "Connecting to ${PGHOST}:${PGPORT}/${PGDATABASE} as ${PGUSER}"

# ─── Ensure migrations table exists ───────────────────────────────────────────
psql -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT
  );
" > /dev/null
log "Migration tracking table ready"

# ─── Apply migrations ─────────────────────────────────────────────────────────
if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
  warn "No migrations directory found at ${MIGRATIONS_DIR}"
  exit 0
fi

APPLIED=0
SKIPPED=0
FAILED=0

for file in $(ls "${MIGRATIONS_DIR}"/*.sql 2>/dev/null | sort); do
  version=$(basename "$file" .sql)
  checksum=$(md5sum "$file" | cut -d' ' -f1)

  # Check if already applied
  ALREADY_APPLIED=$(psql -t -A -c \
    "SELECT COUNT(*) FROM schema_migrations WHERE version = '${version}'" \
    2>/dev/null || echo "0")

  if [[ "${ALREADY_APPLIED}" -gt 0 ]]; then
    log "  SKIP  ${version} (already applied)"
    ((SKIPPED++))
    continue
  fi

  log "  APPLY ${version}..."

  if psql \
    --single-transaction \
    --set ON_ERROR_STOP=1 \
    -f "${file}" > /dev/null 2>&1; then

    # Record successful migration
    psql -c "
      INSERT INTO schema_migrations (version, checksum)
      VALUES ('${version}', '${checksum}')
      ON CONFLICT (version) DO NOTHING;
    " > /dev/null

    log "  DONE  ${version} ✓"
    ((APPLIED++))
  else
    err "  FAIL  ${version} — migration failed"
    err "  Run manually: psql -f ${file}"
    ((FAILED++))
    exit 1
  fi
done

echo ""
log "Migration summary:"
log "  Applied : ${APPLIED}"
log "  Skipped : ${SKIPPED}"
log "  Failed  : ${FAILED}"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi

log "All migrations current ✓"
