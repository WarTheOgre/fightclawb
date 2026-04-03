# arena-identity/Dockerfile
# Multi-stage build — keeps production image lean (~150MB vs ~900MB)

# ── Stage 1: dependency installer ────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /build

# Copy manifests only — layer cached unless package.json changes
COPY services/arena-identity/package*.json ./

RUN npm install --omit=dev --ignore-scripts

# ── Stage 2: full install for testing (not used in prod image) ────────────────
FROM node:22-alpine AS test-deps

WORKDIR /build
COPY services/arena-identity/package*.json ./
RUN npm install --ignore-scripts

# ── Stage 3: production image ─────────────────────────────────────────────────
FROM node:22-alpine AS production

ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown

LABEL org.opencontainers.image.title="Fight Clawb — Identity Service"
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"

# Security: run as non-root user
RUN addgroup -g 1001 -S arena && \
    adduser  -u 1001 -S arena -G arena

WORKDIR /app

# Copy prod dependencies
COPY --from=deps --chown=arena:arena /build/node_modules ./node_modules

# Copy application source
COPY --chown=arena:arena services/arena-identity/src ./src
COPY --chown=arena:arena services/arena-identity/package.json ./

# Build-time metadata
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV NODE_ENV=production

# Node.js production tuning
ENV NODE_OPTIONS="--max-old-space-size=256"

USER arena

EXPOSE 3001

# Health check — allows Docker / Kubernetes to know when container is ready
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
