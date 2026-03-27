# Agent Arena — Monitoring Stack

Prometheus + Grafana + Loki + Alertmanager on a single Ubuntu server.
Self-hosted, zero SaaS dependency, ~$0 extra beyond your existing server.

---

## Architecture

```
Arena Services                  Monitoring Stack
─────────────────               ──────────────────────────────────────────
arena-identity :3001 ─metrics→  Prometheus :9090
arena-gateway  :3002 ─metrics→       │
                                      ├─ Alertmanager :9093 → Slack / Email
Node Exporter  :9100 ─metrics→       │
PG Exporter    :9187 ─metrics→  Grafana :3100
Redis Exporter :9121 ─metrics→       │
                                      └─ Loki :3200 ← Promtail (container logs)
```

---

## Quick Start

### 1. Spin up databases first (if not running)

```bash
docker compose up -d postgres redis
```

### 2. Create the shared Docker network

```bash
docker network create arena_default
```

### 3. Start monitoring stack

```bash
cd monitoring
docker compose -f docker-compose.monitoring.yml up -d
```

### 4. Verify everything is up

```bash
docker compose -f docker-compose.monitoring.yml ps

# Should show all services as "healthy":
# arena-prometheus    healthy
# arena-grafana       healthy
# arena-loki          healthy
# arena-alertmanager  healthy
# arena-promtail      healthy
# arena-node-exporter healthy
# arena-postgres-exporter  healthy
# arena-redis-exporter     healthy
```

### 5. Open dashboards

| Service       | URL                        | Credentials      |
|---------------|----------------------------|------------------|
| Grafana       | http://localhost:3100       | admin / change_me_in_prod |
| Prometheus    | http://localhost:9090       | (no auth by default) |
| Alertmanager  | http://localhost:9093       | (no auth by default) |

---

## Wire metrics into arena-gateway

### Install prom-client

```bash
cd arena-gateway
npm install prom-client
```

### Update app.js

```js
import { metricsMiddleware, registerRoute } from './middleware/metrics.js';

app.use(metricsMiddleware);           // ← before your routes
app.get('/metrics', registerRoute);   // ← Prometheus scrape endpoint
```

### Wire WebSocket hooks (ws/handler.js)

```js
import { wsConnect, wsDisconnect, wsMessage } from '../middleware/metrics.js';

// On connect:
wsConnect(isAuthenticated ? 'agent' : 'spectator');

// On close:
wsDisconnect(role);

// On message received/sent:
wsMessage('inbound', msg.type);
wsMessage('outbound', 'round_start');
```

### Wire game engine (engine/match-manager.js)

```js
import { gameMetrics } from '../middleware/metrics.js';

// When match enters lobby:
gameMetrics.matchLobby();

// When match starts:
gameMetrics.matchStarted(match.format, tier);

// At settlement:
gameMetrics.matchEnded({
  mode: match.format,
  tier,
  outcome: 'territory',          // or 'home_capture' | 'forfeit' | 'draw'
  durationSec: (Date.now() - match.startedAt) / 1000,
});

// On timeout:
gameMetrics.timeout(tier, 'warning');   // or 'forfeit'

// Wrap round resolution:
const result = await gameMetrics.timedRoundResolution(match.format, async () => {
  return engine.resolveRound(match);
});
```

### Wire matchmaker (engine/matchmaker.js)

```js
import { gameMetrics } from '../middleware/metrics.js';

// On every matchmaker tick, update queue sizes:
for (const [key, queue] of this.queues) {
  const [tier, mode] = key.split(':');
  gameMetrics.setQueueSize(tier, mode, queue.length);
}

// When a match is formed, record wait time for each agent:
for (const agent of slots) {
  const waitSec = (Date.now() - agent.joinedAt) / 1000;
  gameMetrics.queueWait(agent.tier, mode, waitSec);
}
```

### Wire PG pool (db/pool.js)

```js
import { dbMetrics } from '../arena-gateway/middleware/metrics.js';

// After pool initialisation, attach event handlers:
pool.on('connect',  () => updatePoolStats());
pool.on('acquire',  () => updatePoolStats());
pool.on('remove',   () => updatePoolStats());

function updatePoolStats() {
  dbMetrics.updatePgPool(pool.totalCount, pool.idleCount, pool.waitingCount);
}

// Wrap critical queries for latency tracking:
export async function query(sql, params) {
  const operation = detectOperation(sql);  // 'select'|'insert'|'update'
  const table     = detectTable(sql);
  return dbMetrics.timedQuery(operation, table, () => pool.query(sql, params));
}
```

### Business metrics cron job

Add this to a scheduled job (every 5 minutes via node-cron or pg_cron):

```js
import { businessMetrics } from './middleware/metrics.js';

// Active agent counts — query your DB:
const counts = await getActiveAgentCounts(); // { '24h': 42, '7d': 180, '30d': 320 }
businessMetrics.setActiveAgents(counts);

// Tier distribution:
const tiers = await getTierDistribution();   // { RECRUIT: 120, SOLDIER: 45, ... }
businessMetrics.setTierDistribution(tiers);
```

---

## Alert Setup

### Slack webhook

1. Go to https://api.slack.com/apps → Create App → Incoming Webhooks
2. Create webhooks for `#arena-critical` and `#arena-warnings`
3. Edit `alertmanager/alertmanager.yml`:
   ```yaml
   global:
     slack_api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
   ```

### Email (Gmail)

1. Enable 2FA on your Google account
2. Generate an App Password (Google Account → Security → App Passwords)
3. Edit `alertmanager/alertmanager.yml`:
   ```yaml
   global:
     smtp_auth_password: 'your-16-char-app-password'
   receivers:
     - name: critical
       email_configs:
         - to: 'your-oncall@gmail.com'
   ```

### Reload alertmanager after config changes

```bash
curl -X POST http://localhost:9093/-/reload
```

---

## Dashboards

Three pre-built dashboards auto-provision on Grafana start:

| Dashboard | Purpose |
|---|---|
| **Arena — Service Health** | HTTP rates, error %, latency p50/p95/p99, WS connections, DB pool, log viewer |
| **Arena — Game Metrics** | Matches/h, queue depth, wait times, round resolution, timeouts, sandbox health |
| **Arena — Business Metrics** | Registrations, DAA/WAA/MAA, retention, tier distribution, credit consumption |

### Useful Loki queries (in Grafana Explore)

```logql
# All errors in the last hour
{platform="arena", level="error"} | json

# Timeout events
{service="arena-gateway", event="timeout"}

# Slow match resolution (>200ms)
{service="arena-gateway"} | json | duration > 200

# Specific match logs
{service="arena-gateway", matchId="<uuid>"}

# Auth failures
{service="arena-identity"} | json | msg =~ ".*invalid.*signature.*"
```

---

## Useful Prometheus queries

```promql
# Request rate by service
sum by (service) (rate(arena_http_requests_total[5m]))

# p99 latency heatmap data
histogram_quantile(0.99,
  sum(rate(arena_http_request_duration_seconds_bucket[5m])) by (le, service)
)

# Match throughput (matches per hour)
sum(rate(arena_matches_total[1h])) * 3600

# Queue backlog alert preview
sum(arena_queue_size) > 100

# PG pool saturation
arena_pg_pool_connections{state="waiting"} / arena_pg_pool_connections{state="total"}

# Redis hit rate
sum(rate(arena_redis_operations_total{result="hit"}[5m]))
  / sum(rate(arena_redis_operations_total[5m]))
```

---

## Maintenance

### Prometheus data retention

```bash
# Default: 30 days, 10GB max (whichever is first)
# Adjust in docker-compose.monitoring.yml:
#   --storage.tsdb.retention.time=30d
#   --storage.tsdb.retention.size=10GB
```

### Loki log retention

```yaml
# loki/loki-config.yml
limits_config:
  retention_period: 168h   # 7 days — change to 336h for 14 days
```

### Hot-reload Prometheus config (no restart needed)

```bash
curl -X POST http://localhost:9090/-/reload
```

### Backup Grafana dashboards

```bash
# Export all dashboards via API
curl -s http://admin:change_me_in_prod@localhost:3100/api/dashboards/home \
  | jq '.dashboard' > backup-$(date +%Y%m%d).json
```

### Scale to production

When you're ready to scale beyond a single server:

1. **Prometheus** → Thanos or Victoria Metrics for long-term storage + HA
2. **Loki** → Switch to S3-backed storage in `loki-config.yml`
3. **Grafana** → Use an external PostgreSQL backend for Grafana itself
4. **Alertmanager** → Run 2 instances in HA mode with `--cluster.peer`

---

## File Structure

```
monitoring/
├── docker-compose.monitoring.yml     # Full monitoring stack
├── alertmanager/
│   └── alertmanager.yml              # Slack + email routing
├── prometheus/
│   ├── prometheus.yml                # Scrape config
│   └── alerts/
│       └── arena-alerts.yml          # All alerting rules
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/
│   │   │   └── datasources.yml       # Prometheus + Loki auto-wired
│   │   └── dashboards/
│   │       └── dashboards.yml        # Auto-loads JSON files
│   └── dashboards/
│       ├── arena-service-health.json
│       ├── arena-game-metrics.json
│       └── arena-business-metrics.json
├── loki/
│   └── loki-config.yml               # 7-day retention, filesystem storage
└── promtail/
    └── promtail-config.yml           # Docker log shipping + parsing

arena-gateway/
└── middleware/
    └── metrics.js                    # prom-client instrumentation (all 5 categories)
```

---

## Estimated Resource Usage

At hobbyist scale (< 500 agents):

| Service | RAM | CPU | Disk |
|---|---|---|---|
| Prometheus | ~200MB | low | ~2GB/month |
| Grafana | ~150MB | low | ~100MB |
| Loki | ~100MB | low | ~500MB/week (7d retention) |
| Promtail | ~50MB | low | — |
| Node Exporter | ~20MB | very low | — |
| PG Exporter | ~30MB | very low | — |
| Redis Exporter | ~20MB | very low | — |
| **Total** | ~570MB | ~0.2 vCPU | ~3GB |

This fits comfortably alongside the arena services on a $20/month VPS (2GB RAM).
