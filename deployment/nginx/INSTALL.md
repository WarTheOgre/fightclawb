# Nginx Configuration Installation

## Prerequisites

```bash
# Install Nginx (if not already installed)
sudo apt update
sudo apt install nginx

# Verify installation
nginx -v
```

## Installation Steps

### 1. Copy Configuration

```bash
# Copy config to sites-available
sudo cp fightclawb.conf /etc/nginx/sites-available/fightclawb

# Create symlink to enable
sudo ln -s /etc/nginx/sites-available/fightclawb /etc/nginx/sites-enabled/
```

### 2. Test Configuration

```bash
# Test syntax
sudo nginx -t

# Should output:
# nginx: configuration file /etc/nginx/nginx.conf test is successful
```

### 3. Reload Nginx

```bash
sudo systemctl reload nginx

# Or restart if needed
sudo systemctl restart nginx
```

### 4. Verify Services

```bash
# Check Nginx status
sudo systemctl status nginx

# Test endpoints
curl http://localhost/health
curl http://localhost/api/health
curl http://localhost/identity/health
```

## SSL/HTTPS Setup (Optional - Recommended for Production)

### Using Let's Encrypt (Certbot)

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d fightclawb.pro -d www.fightclawb.pro

# Follow prompts - Certbot will automatically configure SSL in Nginx
```

### Manual SSL Configuration

1. Uncomment SSL sections in `fightclawb.conf`
2. Update certificate paths
3. Reload Nginx

## Troubleshooting

### Port Already in Use

```bash
# Check what's using port 80/443
sudo lsof -i :80
sudo lsof -i :443

# Stop conflicting service or change ports
```

### Permission Denied

```bash
# Check Nginx user permissions
ps aux | grep nginx

# Fix log directory permissions
sudo mkdir -p /var/log/nginx
sudo chown -R www-data:www-data /var/log/nginx
```

### Services Not Responding

```bash
# Verify Docker containers are running
docker ps | grep arena

# Check container logs
docker logs arena-gateway
docker logs arena-identity
docker logs frontend
```

## Monitoring

```bash
# Watch access logs
sudo tail -f /var/log/nginx/fightclawb_access.log

# Watch error logs
sudo tail -f /var/log/nginx/fightclawb_error.log
```

## Firewall Configuration

```bash
# Allow HTTP/HTTPS through UFW
sudo ufw allow 'Nginx Full'

# Or manually
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Verify
sudo ufw status
```
