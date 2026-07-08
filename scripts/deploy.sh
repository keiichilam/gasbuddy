#!/usr/bin/env bash
set -euo pipefail

DEST=/opt/gasbuddy
SERVICE=gasbuddy-dashboard
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Deploying $SRC → $DEST"

# Sync source (exclude runtime state and virtual envs)
rsync -av --delete \
  --exclude='data/' \
  --exclude='logs/' \
  --exclude='cars.json' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.git/' \
  --exclude='.claude/' \
  --exclude='*.png' \
  "$SRC/" "$DEST/"

# Ensure data and logs dirs exist with correct owner
mkdir -p "$DEST/data" "$DEST/logs"
chown -R bgservice:bgservice "$DEST"
chmod 750 "$DEST"

# Install/reload systemd service
cp "$DEST/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"

# Install OSRM service (conditional start — data must be pre-provisioned via setup_osrm.sh)
if [[ -f "$DEST/deploy/osrm.service" ]]; then
    cp "$DEST/deploy/osrm.service" "/etc/systemd/system/osrm.service"
fi

# Install logrotate config for the hourly scan log
if [[ -f "$DEST/deploy/gasbuddy.logrotate" ]]; then
    cp "$DEST/deploy/gasbuddy.logrotate" "/etc/logrotate.d/gasbuddy"
fi

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

if [[ -f /opt/osrm/british-columbia-latest.osrm ]]; then
    systemctl enable osrm
    systemctl restart osrm
    echo "OSRM service started."
else
    echo "WARNING: /opt/osrm data not found — run scripts/setup_osrm.sh first."
    echo "         Dashboard is running with haversine fallback until OSRM is provisioned."
fi

echo "Done. Check status with: systemctl status $SERVICE"
