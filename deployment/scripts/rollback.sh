#!/usr/bin/env bash
# scripts/rollback.sh — Restore previous image versions
#
# Usage: rollback.sh [sha_tag_to_restore]
#
# Without arguments: reads /opt/fight-clawb/rollback-state.env
# With argument:     rolls back to that specific release directory

set -euo pipefail

STATE_FILE="/opt/fight-clawb/rollback-state.env"
RELEASES_DIR="/opt/fight-clawb/release"
ENV_FILE="/opt/fight-clawb/.env"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[rollback]${NC} $*"; }
warn() { echo -e "${YELLOW}[rollback]${NC} $*"; }
err()  { echo -e "${RED}[rollback]${NC} $*" >&2; }

# ─── Find the target release ──────────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
  TARGET_SHA="${1}"
  TARGET_DIR="${RELEASES_DIR}/${TARGET_SHA}"

  if [[ ! -d "${TARGET_DIR}" ]]; then
    err "Release directory not found: ${TARGET_DIR}"
    err "Available releases:"
    ls "${RELEASES_DIR}" | sort -r | head -5 | while read r; do echo "  ${r}"; done
    exit 1
  fi
else
  # Auto-detect: find second-most-recent release
  TARGET_DIR=$(ls -dt "${RELEASES_DIR}"/sha-* 2>/dev/null | sed -n '2p')

  if [[ -z "${TARGET_DIR}" ]]; then
    err "No previous release found in ${RELEASES_DIR}"
    err "Cannot rollback — this is the first deployment"
    exit 1
  fi
  TARGET_SHA=$(basename "${TARGET_DIR}")
fi

log "Rolling back to: ${TARGET_SHA}"
log "Release dir: ${TARGET_DIR}"

# ─── Rollback state ───────────────────────────────────────────────────────────
CURRENT_IDENTITY=$(docker inspect --format='{{.Config.Image}}' arena-identity 2>/dev/null || echo "none")
CURRENT_GATEWAY=$(docker inspect  --format='{{.Config.Image}}' arena-gateway  2>/dev/null || echo "none")
CURRENT_FRONTEND=$(docker inspect --format='{{.Config.Image}}' arena-frontend 2>/dev/null || echo "none")

log "Current (failing) images:"
log "  identity : ${CURRENT_IDENTITY}"
log "  gateway  : ${CURRENT_GATEWAY}"
log "  frontend : ${CURRENT_FRONTEND}"

# ─── Switch symlink to previous release ──────────────────────────────────────
ln -sfn "${TARGET_DIR}" /opt/fight-clawb/current
log "Symlink updated to ${TARGET_DIR}"

# ─── Pull and restart with old images ────────────────────────────────────────
rollback_service() {
  local name="$1"
  local health_url="$2"

  log "Restarting ${name} with rollback image..."

  docker compose \
    -f /opt/fight-clawb/current/docker-compose.yml \
    -f /opt/fight-clawb/current/docker-compose.prod.yml \
    --env-file "${ENV_FILE}" \
    up -d --no-deps --pull=never "${name}"

  local elapsed=0
  until curl -sf --max-time 3 "${health_url}" > /dev/null 2>&1; do
    if [[ $elapsed -ge 90 ]]; then
      err "${name} STILL unhealthy after rollback — manual intervention required"
      return 1
    fi
    sleep 3
    ((elapsed += 3))
    echo -n "."
  done
  echo ""
  log "${name} healthy ✓"
}

rollback_service "arena-identity" "http://localhost:3001/health"
rollback_service "arena-gateway"  "http://localhost:3002/health"
rollback_service "frontend"       "http://localhost:3000"

# ─── Log the rollback event ───────────────────────────────────────────────────
echo "[$(date -u)] ROLLBACK to ${TARGET_SHA} from current failed state" \
  >> /opt/fight-clawb/logs/deploy-history.log

log "Rollback complete ✓ — running on ${TARGET_SHA}"
warn "IMPORTANT: investigate why the previous deploy failed before re-deploying"
