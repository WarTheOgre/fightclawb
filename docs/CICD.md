# Fight Clawb — CI/CD & Deployment

> Infrastructure for `fightclawb.pro` running on **wunsi-gatu** (Ubuntu 24.04.4)

---

## Architecture at a glance

```
GitHub Push → Test Pipeline → Build Pipeline → Docker Images (GHCR)
                                                      ↓
                                            Manual Deploy Trigger
                                                      ↓
                                      SSH → wunsi-gatu → Rolling Restart
                                                      ↓
                                            Health Checks → ✓ or Rollback
```

---

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `test.yml` | Every push | Lint, audit, unit tests, integration tests, frontend build |
| `build.yml` | Push to `main` | Build + push Docker images to GHCR, smoke test |
| `deploy.yml` | Manual trigger | SSH deploy, migrations, rolling restart, health check |
| `scheduled.yml` | Cron | Daily backup, weekly security scan, monthly dep audit |

---

## One-Time Server Setup (wunsi-gatu)

```bash
# 1. Generate a deploy keypair (on your machine)
ssh-keygen -t ed25519 -C "fight-clawb-deploy" -f ~/.ssh/fight_clawb_deploy -N ""

# 2. SSH to server and run setup
scp scripts/server-setup.sh root@wunsi-gatu:/tmp/
ssh root@wunsi-gatu "bash /tmp/server-setup.sh '$(cat ~/.ssh/fight_clawb_deploy.pub)'"

# 3. Copy your .env to the server
scp .env deploy@wunsi-gatu:/opt/fight-clawb/.env

# 4. Verify docker works for deploy user
ssh deploy@wunsi-gatu "docker ps"
```

---

## GitHub Secrets Required

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description | How to get it |
|---|---|---|
| `SERVER_HOST` | `fightclawb.pro` or IP | Your server address |
| `SERVER_USER` | `deploy` | Set during server-setup.sh |
| `SERVER_SSH_KEY` | Private key | `cat ~/.ssh/fight_clawb_deploy` |
| `SERVER_PORT` | `22` (optional) | SSH port |

`GITHUB_TOKEN` is automatically available — no action needed.

---

## Deploying

### Standard deploy (latest main)

```
GitHub Actions → Deploy workflow → Run workflow → environment: production → Run
```

### Deploy a specific version

```
Run workflow → sha_tag: sha-abc1234 → Run
```

### Emergency: skip migrations

Only use this if you need to rollback an already-failed migration:

```
Run workflow → skip_migrations: true → Run
```

---

## Rollback

**Automatic:** If post-deploy health checks fail, the pipeline automatically runs rollback.sh.

**Manual rollback via SSH:**

```bash
ssh deploy@wunsi-gatu

# Rollback to previous release (auto-detects)
bash /opt/fight-clawb/current/scripts/rollback.sh

# Rollback to specific version
bash /opt/fight-clawb/current/scripts/rollback.sh sha-abc1234

# See what releases are available
ls /opt/fight-clawb/release/
```

---

## Database Migrations

Migrations live in `migrations/` and are named `NNN_description.sql` (e.g. `001_initial_schema.sql`).

The migration runner:
- Tracks applied versions in `schema_migrations` table
- Runs each file in a transaction (`--single-transaction`)
- Fails fast on any error
- Is idempotent — safe to run multiple times

**Run migrations manually:**

```bash
ssh deploy@wunsi-gatu
bash /opt/fight-clawb/current/scripts/migrate.sh /opt/fight-clawb/.env
```

**Add a new migration:**

```bash
# Create next numbered file
touch migrations/002_add_feature.sql

# Write your SQL (always wrap in transactions)
cat > migrations/002_add_feature.sql <<SQL
BEGIN;
ALTER TABLE agents ADD COLUMN new_field TEXT;
COMMIT;
SQL
```

---

## Database Backups

Daily backups run at 02:00 UTC via scheduled workflow. Backups stored on server at `/opt/fight-clawb/backups/` and kept for 30 days.

**Manual backup:**

```bash
# Trigger via GitHub Actions (scheduled.yml → Run workflow → job: backup)
# Or SSH and run:
ssh deploy@wunsi-gatu
source /opt/fight-clawb/.env
PGPASSWORD=$PGPASSWORD pg_dump -h $PGHOST -U $PGUSER $PGDATABASE | \
  gzip > /opt/fight-clawb/backups/manual_$(date +%Y%m%d).sql.gz
```

**Restore from backup:**

```bash
ssh deploy@wunsi-gatu
source /opt/fight-clawb/.env
gunzip -c /opt/fight-clawb/backups/arena_20260101_020000.sql.gz | \
  PGPASSWORD=$PGPASSWORD psql -h $PGHOST -U $PGUSER $PGDATABASE
```

---

## Health Checks

All services expose `/health` endpoints:

```bash
curl http://localhost:3001/health   # Identity
curl http://localhost:3002/health   # Gateway
curl http://localhost:3000          # Frontend
```

Expected response from the Node services:

```json
{
  "status": "ok",
  "db": "connected",
  "redis": "connected",
  "uptime": 12345
}
```

**Fix: "db unavailable" in health checks**

The current DB connection issue is likely the services can't reach PostgreSQL. Check:

```bash
# On wunsi-gatu:
docker compose logs arena-identity | tail -50
docker exec arena-identity wget -qO- http://localhost:3001/health

# Verify DB is reachable from inside the container
docker exec arena-identity sh -c 'nc -zv postgres 5432'

# Check env vars are set
docker exec arena-identity env | grep PG
```

Common cause: `DATABASE_URL` not set in the container's environment. Ensure `/opt/fight-clawb/.env` is complete and the compose command is reading it.

---

## Directory Layout on Server

```
/opt/fight-clawb/
├── .env                    ← master env file (never commit)
├── current/                ← symlink to active release
│   ├── docker-compose.yml
│   ├── docker-compose.prod.yml
│   ├── scripts/
│   └── migrations/
├── release/
│   ├── sha-abc1234/        ← last 3 releases kept
│   ├── sha-def5678/
│   └── sha-ghi9012/
├── backups/
│   └── arena_20260326_020000.sql.gz
├── nginx/
│   └── nginx.conf
└── logs/
    ├── deploy-sha-abc1234.log
    └── deploy-history.log
```

---

## Adding a New Service

1. Add a new `Dockerfile` (copy an existing one as template)
2. Add to `docker-compose.yml` and `docker-compose.prod.yml`
3. Add a build matrix entry in `build.yml`
4. Add health check in `deploy.yml`
5. Add nginx location block in `nginx.conf`

---

## Known Issues

| Issue | Status | Fix |
|---|---|---|
| DB "unavailable" in health checks | 🔧 Active | Check `DATABASE_URL` env var in container; see Health Checks section above |
| Alertmanager restarting | ℹ️ Non-critical | Non-critical monitoring component; investigate when DB is stable |
| Frontend cosmetic issues (3) | 📋 Backlog | Address in separate frontend PR |

---

## Secrets Rotation

```bash
# Rotate JWT_SECRET (requires restart of both services)
openssl rand -hex 64  # generate new secret
# Update /opt/fight-clawb/.env on server
# Update JWT_SECRET in GitHub Secrets (for build-time injection if needed)
# Re-deploy

# Rotate DB password
# 1. Update in PostgreSQL: ALTER ROLE arena PASSWORD 'newpass';
# 2. Update in /opt/fight-clawb/.env
# 3. Restart services: docker compose restart arena-identity arena-gateway
```
