#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=/opt/gasbuddy
PYTHON="${PYTHON:-python3}"
LOG_DIR="$ROOT_DIR/logs"
LOCK_FILE="$LOG_DIR/scan.lock"

# Conservative, explicit rate-limit defaults so the hourly job's behavior is
# pinned and does not drift if code defaults change. Override with SCAN_ARGS.
SCAN_ARGS="${SCAN_ARGS:---max-pages 1 --page-delay 2 --city-delay 15 --retries 2 --retry-delay 30}"
SAFE_ARGS_RE='^[a-zA-Z0-9_.,'"'"' =-]+$'
if [[ -n "$SCAN_ARGS" && ! "$SCAN_ARGS" =~ $SAFE_ARGS_RE ]]; then
  echo "Error: SCAN_ARGS contains disallowed characters: $SCAN_ARGS" >&2
  exit 1
fi
# flock -n prevents a slow scan from overlapping with the next hourly run.
JOB="0 * * * * cd \"$ROOT_DIR\" && /usr/bin/flock -n \"$LOCK_FILE\" \"$PYTHON\" scan.py $SCAN_ARGS >> \"$LOG_DIR/scan.log\" 2>&1"
MARKER="# gasbuddy-hourly-scan"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Strip any prior gasbuddy scan entry (marker line and the scan.py job line,
# with or without args) so re-running never duplicates the job.
sudo -u bgservice crontab -l 2>/dev/null | grep -vF "$MARKER" | grep -v "scan.py" > "$tmp" || true
{
  cat "$tmp"
  echo "$MARKER"
  echo "$JOB"
} | sudo -u bgservice crontab -

echo "Installed hourly GasBuddy scan cron for bgservice:"
echo "$JOB"
