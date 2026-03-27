#!/usr/bin/env bash
# scripts/deploy.sh — Rolling restart with health checks
#
# Usage: deploy.sh <release_dir> <sha_tag> <image_prefix>
#
# Called by the GitHub Actions deploy workflow via SSH.
# Assumes Docker + docker-compose are available on the server.

set -euo pipefail

RELEASE_DIR="${1:?Release dir required}"
SHA_TAG="${2:?SHA tag required}"
IMAGE_PREFIX="${3:?Image prefix required}"

COMPOSE_BASE="/opt/fight-clawb/current/docker-compose.yml"
COMPOSE_PROD="/opt/fight-clawb/current/docker-compose.prod.yml"
ENV_FILE="/opt/fight-clawb/.env"

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*" >&2; }

# ─── Snapshot current state (for rollback) ───────────────────────────────────
PREV_IDENTITY=$(docker inspect --format='{{.Config.Image}}' arena-identity 2>/dev/null || echo "none")
PREV_GATEWAY=$(docker inspect  --format='{{.Config.Image}}' arena-gateway  2>/dev/null || echo "none")
PREV_FRONTEND=$(docker inspect --format='{{.Config.Image}}' arena-frontend 2>/dev/null || echo "none")

log "Previous images:"
log "  identity : ${PREV_IDENTITY}"
log "  gateway  : ${PREV_GATEWAY}"
log "  frontend : ${PREV_FRONTEND}"

# Save for rollback script to reference
cat > /opt/fight-clawb/rollback-state.env <<EOF
PREV_IDENTITY=${PREV_IDENTITY}
PREV_GATEWAY=${PREV_GATEWAY}
PREV_FRONTEND=${PREV_FRONTEND}
PREV_SHA_TAG=${SHA_TAG}
ROLLBACK_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

# ─── Point symlink at new release ────────────────────────────────────────────
ln -sfn "${RELEASE_DIR}" /opt/fight-clawb/current

# ─── Rolling restart: one service at a time ──────────────────────────────────
restart_service() {
  local name="$1"
  local health_url="$2"
  local max_wait="${3:-60}"

  log "Restarting ${name}..."

  docker compose \
    -f /opt/fight-clawb/current/docker-compose.yml \
    -f /opt/fight-clawb/current/docker-compose.prod.yml \
    --env-file "${ENV_FILE}" \
    up -d --no-deps --pull=never "${name}"

  log "Waiting for ${name} to become healthy (max ${max_wait}s)..."
  local elapsed=0
  until curl -sf --max-time 3 "${health_url}" > /dev/null 2>&1; do
    if [[ $elapsed -ge $max_wait ]]; then
      err "${name} did not become healthy within ${max_wait}s"
      return 1
    fi
    sleep 3
    ((elapsed += 3))
    echo -n "."
  done
  echo ""
  log "${name} healthy after ${elapsed}s ✓"
}

# Restart in dependency order:
# 1. Identity (no deps on other services)
# 2. Gateway (depends on identity for JWT verification)
# 3. Frontend (depends on both APIs)
restart_service "arena-identity" "http://localhost:3001/health" 60
restart_service "arena-gateway"  "http://localhost:3002/health" 60
restart_service "frontend"       "http://localhost:3000"        90

# Nginx doesn't need restart unless config changed
if [[ -f "/opt/fight-clawb/nginx/nginx.conf.new" ]]; then
  warn "New nginx config detected — reloading nginx"
  mv /opt/fight-clawb/nginx/nginx.conf.new /opt/fight-clawb/nginx/nginx.conf
  docker exec arena-nginx nginx -s reload
fi

log "Rolling restart complete ✓"
log "Deployed: ${SHA_TAG}"
