# frontend/Dockerfile
# Multi-stage Next.js build — standalone output for minimal image

# ── Stage 1: deps ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts

# ── Stage 2: builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

ARG BUILD_SHA=unknown
ARG NEXT_PUBLIC_GATEWAY_URL
ARG NEXT_PUBLIC_IDENTITY_URL

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY frontend/ .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# next.config.js should have: output: 'standalone'
RUN npm run build

# ── Stage 3: production runner ────────────────────────────────────────────────
FROM node:22-alpine AS production

ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown

LABEL org.opencontainers.image.title="Fight Clawb — Frontend"
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"

RUN addgroup -g 1001 -S arena && \
    adduser  -u 1001 -S arena -G arena

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Next.js standalone output bundles everything needed
COPY --from=builder --chown=arena:arena /app/.next/standalone ./
COPY --from=builder --chown=arena:arena /app/.next/static     ./.next/static
COPY --from=builder --chown=arena:arena /app/public           ./public

USER arena

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || wget -qO- http://localhost:3000 || exit 1

CMD ["node", "server.js"]
