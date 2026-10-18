#!/usr/bin/env bash
# Shop Desk installer for Linux (systemd).
#   sudo ./install-shopdesk.sh
# Optional environment variables:
#   PORT=8765 INSTALL_DIR=/opt/shopdesk DATA_DIR=/var/lib/shopdesk SHOP_GOOGLE_CLIENT_ID=... SHOP_GOOGLE_CLIENT_SECRET=...
set -euo pipefail

PORT="${PORT:-8765}"
INSTALL_DIR="${INSTALL_DIR:-/opt/shopdesk}"
DATA_DIR="${DATA_DIR:-/var/lib/shopdesk}"
SERVICE_USER="${SERVICE_USER:-shopdesk}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fail "Run this installer with sudo."
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 22.13 or newer, then run this again."
NODE_BIN="$(command -v node)"
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node.js $NODE_VERSION is too old. Shop Desk needs 22.13 or newer."
say "Using Node.js $NODE_VERSION at $NODE_BIN"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating the $SERVICE_USER system user"
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

say "Copying Shop Desk to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'tools' --exclude 'data' --exclude 'vendor' \
    --exclude 'releases' --exclude 'licences' --exclude 'private' --exclude 'ShopDesk-Licence-Kit' \
    --exclude '*.sqlite3' --exclude '*.sqlite3-wal' --exclude '*.sqlite3-shm' --exclude 'server.log' \
    --exclude '*.pem' --exclude 'licences.csv' --exclude '3 - Build Licence Kit.bat' --exclude '4 - Issue Customer Licence.bat' \
    "$SOURCE_DIR"/ "$INSTALL_DIR"/
else
  tar -C "$SOURCE_DIR" --exclude='.git' --exclude='node_modules' --exclude='data' --exclude='vendor' \
      --exclude='releases' --exclude='licences' --exclude='private' --exclude='ShopDesk-Licence-Kit' --exclude='tools' \
      --exclude='*.sqlite3*' --exclude='*.pem' --exclude='licences.csv' --exclude='server.log' \
      --exclude='3 - Build Licence Kit.bat' --exclude='4 - Issue Customer Licence.bat' \
      -cf - . | tar -C "$INSTALL_DIR" -xf -
fi

# The vendor signing key is never copied to a shop server.

say "Writing /etc/shopdesk.env"
cat > /etc/shopdesk.env <<ENV
PORT=$PORT
SHOP_HOST=0.0.0.0
SHOP_DATA_DIR=$DATA_DIR
# Optional:
# SHOP_PUBLIC_URL=https://shop.example.com
# SHOP_TRUST_PROXY=1
# SHOP_GOOGLE_CLIENT_ID=
# SHOP_GOOGLE_CLIENT_SECRET=
# SHOP_GMAIL_USER=
# SHOP_GMAIL_APP_PASSWORD=
ENV
if [[ -n "${SHOP_GOOGLE_CLIENT_ID:-}" ]]; then echo "SHOP_GOOGLE_CLIENT_ID=$SHOP_GOOGLE_CLIENT_ID" >> /etc/shopdesk.env; fi
if [[ -n "${SHOP_GOOGLE_CLIENT_SECRET:-}" ]]; then echo "SHOP_GOOGLE_CLIENT_SECRET=$SHOP_GOOGLE_CLIENT_SECRET" >> /etc/shopdesk.env; fi
if [[ -n "${SHOP_PUBLIC_URL:-}" ]]; then
  echo "SHOP_PUBLIC_URL=$SHOP_PUBLIC_URL" >> /etc/shopdesk.env
  echo "SHOP_TRUST_PROXY=1" >> /etc/shopdesk.env
fi

say "Installing the systemd service"
sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__DATA_DIR__|$DATA_DIR|g" -e "s|__NODE__|$NODE_BIN|g" \
  "$INSTALL_DIR/install/linux/shopdesk.service" > /etc/systemd/system/shopdesk.service
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$INSTALL_DIR" 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now shopdesk.service

if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
fi

say "Waiting for Shop Desk"
healthy=0
for _ in $(seq 1 30); do
  sleep 1
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then healthy=1; break; fi
  elif "$NODE_BIN" -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    healthy=1; break
  fi
done
if [[ "$healthy" -ne 1 ]]; then
  fail "Shop Desk did not answer on port $PORT. Check: journalctl -u shopdesk -n 60 --no-pager"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<SUMMARY

=====================================================
 Shop Desk is installed and running.

 This server:  http://localhost:$PORT/
 Phones:       http://${LAN_IP:-<server-ip>}:$PORT/   (same Wi-Fi)
 Connect a phone (QR): http://${LAN_IP:-localhost}:$PORT/join
 Data folder:  $DATA_DIR
 Service:      systemctl status shopdesk
 Logs:         journalctl -u shopdesk -f

 First run: the one-time setup code is printed in the logs:
   journalctl -u shopdesk -n 50 | grep -A2 "setup code"

 Optional HTTPS (needed for installable PWA and offline caching):
   put Nginx or Caddy in front and set SHOP_PUBLIC_URL + SHOP_TRUST_PROXY=1
   in /etc/shopdesk.env, then: systemctl restart shopdesk
=====================================================
SUMMARY
