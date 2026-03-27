# arena-gateway/Dockerfile
# Multi-stage build — lean production image

# ── Stage 1: deps ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /build
COPY arena-gateway/package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM node:22-alpine AS production

ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown

LABEL org.opencontainers.image.title="Fight Clawb — Gateway Service"
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
LABEL org.opencontainers.image.created="${BUILD_TIME}"

RUN addgroup -g 1001 -S arena && \
    adduser  -u 1001 -S arena -G arena

WORKDIR /app

COPY --from=deps --chown=arena:arena /build/node_modules ./node_modules
COPY --chown=arena:arena arena-gateway/src ./src
COPY --chown=arena:arena arena-gateway/package.json ./

ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512"

USER arena

EXPOSE 3002

# Gateway also serves WebSockets — health check hits HTTP /health
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1

CMD ["node", "src/app.js"]
