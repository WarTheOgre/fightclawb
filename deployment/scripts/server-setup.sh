#!/usr/bin/env bash
# scripts/server-setup.sh — One-time server setup for wunsi-gatu
#
# Run as root (or with sudo) on a fresh Ubuntu 24.04 box.
# After this runs, the deploy user can SSH in and run deploy.sh.
#
# Usage: bash server-setup.sh <deploy_public_key>

set -euo pipefail

DEPLOY_USER="deploy"
ARENA_DIR="/opt/fight-clawb"
DOMAIN="fightclawb.pro"

log() { echo -e "\033[0;32m[setup]\033[0m $*"; }

# ─── System deps ──────────────────────────────────────────────────────────────
log "Installing system dependencies..."
apt-get update -q
apt-get install -y \
  curl ca-certificates gnupg lsb-release \
  nginx certbot python3-certbot-nginx \
  postgresql-client-16 \
  fail2ban ufw \
  jq htop

# ─── Docker ───────────────────────────────────────────────────────────────────
log "Installing Docker..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -q
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# ─── Deploy user ──────────────────────────────────────────────────────────────
log "Creating deploy user..."
id "${DEPLOY_USER}" &>/dev/null || useradd -m -s /bin/bash "${DEPLOY_USER}"
usermod -aG docker "${DEPLOY_USER}"

# Add deploy public key
if [[ -n "${1:-}" ]]; then
  mkdir -p "/home/${DEPLOY_USER}/.ssh"
  echo "$1" >> "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  chmod 700 "/home/${DEPLOY_USER}/.ssh"
  chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
  log "Deploy key installed ✓"
fi

# ─── Arena directory structure ────────────────────────────────────────────────
log "Creating arena directory structure..."
mkdir -p \
  "${ARENA_DIR}"/{release,backups,logs,nginx} \
  /opt/fight-clawb/nginx/logs

# Symlink (will be overwritten on first deploy)
touch "${ARENA_DIR}/.env"

chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${ARENA_DIR}"

# ─── UFW firewall ─────────────────────────────────────────────────────────────
log "Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
# Internal metrics (restrict to monitoring server IP if available)
# ufw allow from <monitoring_ip> to any port 9090
ufw --force enable

# ─── Fail2ban ─────────────────────────────────────────────────────────────────
log "Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true

[nginx-http-auth]
enabled = true
EOF
systemctl enable --now fail2ban

# ─── Nginx config for fightclawb.pro ─────────────────────────────────────────
log "Writing nginx config..."
cat > /opt/fight-clawb/nginx/nginx.conf <<'EOF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    # Logging
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent"';
    access_log /var/log/nginx/access.log main;

    # Performance
    sendfile on;
    keepalive_timeout 65;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;
    limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/m;

    # Redirect HTTP → HTTPS
    server {
        listen 80;
        server_name fightclawb.pro www.fightclawb.pro;
        return 301 https://$host$request_uri;
    }

    # Main HTTPS server
    server {
        listen 443 ssl http2;
        server_name fightclawb.pro www.fightclawb.pro;

        ssl_certificate     /etc/letsencrypt/live/fightclawb.pro/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/fightclawb.pro/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;

        # Frontend (Next.js)
        location / {
            proxy_pass http://frontend:3000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # Identity API
        location /api/identity/ {
            limit_req zone=api burst=10 nodelay;
            proxy_pass http://arena-identity:3001/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }

        # Auth endpoints — stricter rate limiting
        location /api/identity/auth/ {
            limit_req zone=auth burst=5 nodelay;
            proxy_pass http://arena-identity:3001/auth/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        # Gateway API
        location /api/ {
            limit_req zone=api burst=20 nodelay;
            proxy_pass http://arena-gateway:3002/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }

        # WebSocket
        location /ws {
            proxy_pass http://arena-gateway:3002/ws;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
        }
    }
}
EOF

# ─── SSL certificate ──────────────────────────────────────────────────────────
log "Obtaining SSL certificate..."
# Start nginx temporarily to serve ACME challenges
systemctl start nginx || true
certbot --nginx \
  -d "${DOMAIN}" \
  -d "www.${DOMAIN}" \
  --non-interactive \
  --agree-tos \
  --email "admin@${DOMAIN}" \
  --redirect \
  || warn "Certbot failed — run manually after DNS propagates"

# Auto-renew
(crontab -l 2>/dev/null; echo "0 12 * * * /usr/bin/certbot renew --quiet") | crontab -

# ─── Log rotation ─────────────────────────────────────────────────────────────
cat > /etc/logrotate.d/fight-clawb <<'EOF'
/opt/fight-clawb/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 deploy deploy
}
EOF

log ""
log "Server setup complete ✓"
log ""
log "Next steps:"
log "  1. Copy your .env file to /opt/fight-clawb/.env"
log "  2. Add GitHub Secrets:"
log "     SERVER_HOST=${DOMAIN}"
log "     SERVER_USER=${DEPLOY_USER}"
log "     SERVER_SSH_KEY=<deploy private key>"
log "  3. Push to main branch — CI/CD will handle the rest"
