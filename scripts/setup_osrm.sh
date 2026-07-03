#!/usr/bin/env bash
set -euo pipefail

OSRM_DIR=/opt/osrm
PBF_URL="https://download.geofabrik.de/north-america/canada/british-columbia-latest.osm.pbf"
PBF="$OSRM_DIR/british-columbia-latest.osm.pbf"
IMAGE="osrm/osrm-backend:latest"

echo "=== OSRM setup for British Columbia ==="
echo "Data directory : $OSRM_DIR"
echo "Docker image   : $IMAGE"
echo ""

mkdir -p "$OSRM_DIR"

if [[ -f "$PBF" ]]; then
    echo "PBF already present at $PBF — skipping download."
    echo "Delete it manually to force a re-download."
else
    echo "Downloading BC OSM data (~300 MB)..."
    curl -L --progress-bar --fail -o "$PBF" "$PBF_URL"
    echo "Download complete."
fi

echo ""
echo "=== Step 1/3: Extract (car profile, MLD) ==="
docker run --rm \
    -v "$OSRM_DIR:/data" \
    "$IMAGE" \
    osrm-extract -p /opt/car.lua /data/british-columbia-latest.osm.pbf

echo ""
echo "=== Step 2/3: Partition ==="
docker run --rm \
    -v "$OSRM_DIR:/data" \
    "$IMAGE" \
    osrm-partition /data/british-columbia-latest.osrm

echo ""
echo "=== Step 3/3: Customize ==="
docker run --rm \
    -v "$OSRM_DIR:/data" \
    "$IMAGE" \
    osrm-customize /data/british-columbia-latest.osrm

echo ""
echo "=== OSRM preprocessing complete ==="
echo "Processed data: $OSRM_DIR"
echo "Run: systemctl start osrm"
