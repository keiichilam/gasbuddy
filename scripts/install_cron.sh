#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=/opt/gasbuddy
PYTHON="${PYTHON:-python3}"
LOG_DIR="$ROOT_DIR/logs"

SCAN_ARGS="${SCAN_ARGS:-}"
SAFE_ARGS_RE='^[a-zA-Z0-9_.,'"'"' =-]+$'
if [[ -n "$SCAN_ARGS" && ! "$SCAN_ARGS" =~ $SAFE_ARGS_RE ]]; then
  echo "Error: SCAN_ARGS contains disallowed characters: $SCAN_ARGS" >&2
  exit 1
fi
JOB="0 * * * * cd \"$ROOT_DIR\" && \"$PYTHON\" scan.py $SCAN_ARGS >> \"$LOG_DIR/scan.log\" 2>&1"
MARKER="# gasbuddy-hourly-scan"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

sudo -u bgservice crontab -l 2>/dev/null | grep -v "$MARKER" | grep -v "scan.py >> .*scan.log" > "$tmp" || true
{
  cat "$tmp"
  echo "$MARKER"
  echo "$JOB"
} | sudo -u bgservice crontab -

echo "Installed hourly GasBuddy scan cron for bgservice:"
echo "$JOB"
