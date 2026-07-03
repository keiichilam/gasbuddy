# BC GasBuddy Trend Collector

Small Python project that scans Lower Mainland GasBuddy prices, stores station and price observations in SQLite, and serves a local trend dashboard.

The collector uses GasBuddy's web GraphQL endpoint with city-center coordinates for the requested British Columbia locations. Coordinate search avoids ambiguous city names such as `Richmond`, which can otherwise resolve to a US city.

## Included Cities

- Richmond
- Vancouver
- Burnaby
- Delta
- Surrey
- New Westminster
- Ladner
- Tsawwassen
- White Rock
- Coquitlam
- Port Coquitlam
- Aldergrove
- Langley

## Run a Scan

```bash
python3 scan.py
```

The database is created at `data/gasbuddy.db`. Scan status and per-city errors are stored in `scan_runs` and `city_runs`, so blocked or failed requests are visible in the dashboard.

Useful scan options:

```bash
python3 scan.py --city richmond
python3 scan.py --max-pages 1 --city-delay 8
python3 scan.py --timeout 30
python3 scan.py --retries 2 --retry-delay 30
```

Defaults are intentionally conservative:

- `--max-pages 1`: fetches one station page per city.
- `--city-delay 8`: waits between city requests.
- `--page-delay 2`: waits between paginated requests if deeper paging is enabled.
- `--retries 2`: retries retryable HTTP failures such as `429` and `5xx`.
- `--retry-delay 30`: waits before retrying, with a simple increasing delay.

These limits reduce the chance of GasBuddy/Cloudflare rate limiting. A scan reuses one GasBuddy CSRF token across all cities and refreshes it only if the GraphQL request rejects the token, which avoids repeated `/home` token requests.

The same defaults can be set with environment variables:

```bash
GASWATCH_TIMEOUT=30
GASWATCH_MAX_AGE_HOURS=0
GASWATCH_MAX_PAGES=1
GASWATCH_PAGE_DELAY=2
GASWATCH_CITY_DELAY=8
GASWATCH_RETRIES=2
GASWATCH_RETRY_DELAY=30
GASWATCH_HOST=0.0.0.0
GASWATCH_PORT=20443
GASWATCH_CERTFILE=/etc/letsencrypt/live/gas.keifu.ca/fullchain.pem
GASWATCH_KEYFILE=/etc/letsencrypt/live/gas.keifu.ca/privkey.pem
GASWATCH_GOOGLE_CLIENT_ID=<google-oauth-client-id>
GASWATCH_GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GASWATCH_GOOGLE_REDIRECT_URI=https://gas.keifu.ca/auth/google/callback
GASWATCH_ALLOWED_DOMAINS=gmail.com
# Optional stricter allow-list:
# GASWATCH_ALLOWED_EMAILS=you@gmail.com,other@gmail.com
```

## Install Hourly Cron

```bash
bash scripts/install_cron.sh
```

This installs:

```cron
0 * * * * cd /home/openclaw/project/gasbuddy && python3 scan.py >> /home/openclaw/project/gasbuddy/logs/scan.log 2>&1
```

To pass scan flags into the cron job:

```bash
SCAN_ARGS="--max-pages 1 --city-delay 12" bash scripts/install_cron.sh
```

## Start Dashboard

```bash
python3 dashboard.py --host 0.0.0.0 --port 20443
```

Open `http://127.0.0.1:20443/` locally, or use the host LAN address from another machine, for example `http://192.168.4.236:20443/`.

The dashboard currently exposes:

- `/`: browser dashboard.
- `/api/health`: dashboard and database health.
- `/api/summary`: latest scan and city-level summary.
- `/api/trends?fuel=regular_gas&hours=168`: city trend points.
- `/api/latest`: lowest current station prices.
- `/api/runs`: recent scan and per-city run status.

## Google Authentication

Google OAuth is disabled unless both of these are set:

```bash
GASWATCH_GOOGLE_CLIENT_ID=<google-oauth-client-id>
GASWATCH_GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
```

For the Google Cloud OAuth client, configure:

```text
Authorized JavaScript origins: https://gas.keifu.ca
Authorized redirect URIs:    https://gas.keifu.ca/auth/google/callback
```

Access can be restricted with either setting. `GASWATCH_ALLOWED_EMAILS` is the strictest option and wins when present; otherwise `GASWATCH_ALLOWED_DOMAINS` allows any verified Google account in those domains. The deployed service defaults the domain allow-list to `gmail.com`.

```bash
GASWATCH_ALLOWED_EMAILS=you@gmail.com,other@gmail.com
GASWATCH_ALLOWED_DOMAINS=gmail.com
```

## Common Commands

```bash
make check
make scan
make dashboard
make health
make cron
```

`make check` runs Python compile checks, JavaScript syntax validation, and the standard-library unit test suite under `tests/`.

## System Service

The dashboard runs under systemd from `/opt/gasbuddy` with HTTPS via the Let's Encrypt certificate for `gas.keifu.ca`.

### Deploy

Run as root:

```bash
sudo bash scripts/deploy.sh
```

This syncs the project to `/opt/gasbuddy`, installs the systemd unit, enables it to start on boot, and starts it immediately.

Open the firewall if needed:

```bash
sudo ufw allow 20443/tcp
```

### Manual steps (equivalent)

```bash
sudo rsync -av --delete \
  --exclude='data/' --exclude='logs/' --exclude='__pycache__/' --exclude='.git/' \
  ./ /opt/gasbuddy/
sudo cp deploy/gasbuddy-dashboard.service /etc/systemd/system/gasbuddy-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now gasbuddy-dashboard.service
```

### Status and logs

```bash
systemctl status gasbuddy-dashboard.service
journalctl -u gasbuddy-dashboard.service -f
```

### HTTPS configuration

The service reads cert paths from environment variables (see `deploy/gasbuddy-dashboard.service`):

```
GASWATCH_CERTFILE=/etc/letsencrypt/live/gas.keifu.ca/fullchain.pem
GASWATCH_KEYFILE=/etc/letsencrypt/live/gas.keifu.ca/privkey.pem
GASWATCH_GOOGLE_CLIENT_ID=<google-oauth-client-id>
GASWATCH_GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
GASWATCH_GOOGLE_REDIRECT_URI=https://gas.keifu.ca/auth/google/callback
GASWATCH_ALLOWED_DOMAINS=gmail.com
# Optional stricter allow-list:
# GASWATCH_ALLOWED_EMAILS=you@gmail.com,other@gmail.com
```

The dashboard can also be started manually with explicit cert paths:

```bash
python3 dashboard.py --host 0.0.0.0 --port 20443 \
  --certfile /etc/letsencrypt/live/gas.keifu.ca/fullchain.pem \
  --keyfile  /etc/letsencrypt/live/gas.keifu.ca/privkey.pem
```

Open `https://<host>:20443/` in a browser.

### Certificate renewal

Certbot renews certificates automatically. To reload the cert after renewal, add a deploy hook:

```bash
# /etc/letsencrypt/renewal-hooks/deploy/gasbuddy.sh
#!/bin/bash
systemctl restart gasbuddy-dashboard.service
```

## Data Model

- `cities`: configured BC cities and source URLs.
- `scan_runs`: one row per scheduled scan.
- `city_runs`: status, counts, raw response, and error per city per scan.
- `stations`: normalized station identity and address details.
- `price_observations`: station fuel price observations over time.
- `city_snapshots`: min, average, and max price per city/fuel/scan for trend charts.

## Operational Notes

GasBuddy may block or throttle automated requests depending on host/network reputation. Common failures are:

- HTTP `403`: request blocked.
- HTTP `429`: Cloudflare rate limit.
- Missing CSRF token: GasBuddy changed the `/home` page token shape or blocked the token request.

The collector records these errors in `city_runs` and keeps the dashboard usable instead of hiding failures.

Logs from cron scans are written to:

```text
logs/scan.log
```

To inspect recent runs directly:

```bash
sqlite3 data/gasbuddy.db "SELECT id, started_at, status, cities_ok, prices_seen, error FROM scan_runs ORDER BY id DESC LIMIT 10;"
```
