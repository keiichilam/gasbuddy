# BC GasBuddy Trend Collector

This project is a Python-based utility that collects gas prices from GasBuddy for various cities in British Columbia, stores them in a SQLite database, and provides a web-based dashboard to visualize price trends.

## Project Overview

- **Purpose:** Monitor and visualize fuel price trends in the BC Lower Mainland.
- **Architecture:**
    - **Collector (`scan.py`):** A script that scrapes GasBuddy's GraphQL endpoint for station and price data.
    - **Database (`data/gasbuddy.db`):** SQLite database storing stations, price observations, and scan history.
    - **Dashboard (`dashboard.py`):** A lightweight Python web server (using `http.server`) that serves a browser-based dashboard and a REST API.
    - **Frontend (`static/`):** Vanilla JavaScript, CSS, and HTML for the dashboard.
    - **Infrastructure:** Uses `cron` for periodic scans and `systemd` for the dashboard service.

## Key Technologies

- **Backend:** Python 3 (Standard library + `sqlite3`)
- **Frontend:** HTML5, CSS3, Vanilla JavaScript (no frameworks)
- **Database:** SQLite (WAL mode enabled)
- **Data Source:** GasBuddy GraphQL API
- **Deployment:** Linux, systemd, crontab, Let's Encrypt (SSL)

## Project Structure

- `gaswatch/`: Core Python package.
    - `config.py`: Configuration defaults, city list, and coordinate mappings.
    - `db.py`: Database schema definition and CRUD operations.
    - `scraper.py`: Logic for interacting with the GasBuddy GraphQL API.
- `static/`: Frontend assets (HTML, JS, CSS).
- `data/`: SQLite database files and local JSON data.
- `scripts/`: Utility scripts for deployment and cron installation.
- `deploy/`: systemd service unit file.
- `tests/`: Unit tests for the database, scraper, and logic.
- `logs/`: Scan logs (e.g., `scan.log`).
- `scan.py`: CLI entry point for running a price scan.
- `dashboard.py`: Entry point for the web dashboard and API server.
- `trip.py`: Utility for fuel cost calculations (likely used for specific features).

## Building and Running

### Prerequisites
- Python 3.8+
- Node.js (only for `make check` syntax validation)

### Initialization
The database is automatically initialized when running a scan for the first time.

### Common Commands
All major tasks are orchestrated via the `Makefile`:

- **Run a scan:** `make scan` (or `python3 scan.py`)
- **Start the dashboard:** `make dashboard` (or `python3 dashboard.py`)
- **Run tests and checks:** `make check` (runs Python compile checks, JS syntax check, and unit tests)
- **Install cron job:** `make cron` (installs an hourly scan job)
- **Check API health:** `make health`

### Scanning Options
`scan.py` supports several flags for fine-tuning:
- `--city <slug>`: Scan a specific city (e.g., `richmond`).
- `--max-pages <int>`: Number of station pages to fetch (default: 1).
- `--city-delay <float>`: Seconds to wait between city requests.

## Configuration

Configuration is primarily handled via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `GASWATCH_HOST` | Dashboard listen host | `0.0.0.0` |
| `GASWATCH_PORT` | Dashboard listen port | `20443` |
| `GASWATCH_TIMEOUT` | HTTP request timeout | `30` |
| `GASWATCH_MAX_PAGES` | Pages per city scan | `1` |
| `GASWATCH_CITY_DELAY` | Delay between cities | `15.0` |
| `GASWATCH_GOOGLE_CLIENT_ID` | Google OAuth Client ID | (Optional) |
| `GASWATCH_GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | (Optional) |

Refer to `README.md` for a full list of supported environment variables.

## Data Model (SQLite)

- `cities`: Metadata for tracked BC cities.
- `scan_runs`: History of collector executions.
- `city_runs`: Results and status of scans per city.
- `stations`: Normalized station details (name, brand, address, location).
- `price_observations`: Individual price points collected over time.
- `city_snapshots`: Aggregated price stats (min, avg, max) per city/fuel type.

## Development Conventions

- **Code Style:** Follow standard PEP 8 conventions.
- **Minimal Dependencies:** Prefer the Python standard library for backend tasks.
- **Frontend:** Keep the frontend "vanilla" (no build step, no NPM dependencies for the runtime).
- **Testing:** Add unit tests in the `tests/` directory for new logic.
- **Validation:** Always run `make check` before committing changes to ensure syntax correctness and passing tests.
- **Database:** Use `WAL` mode and foreign keys (handled in `gaswatch/db.py`).

## Deployment

The project is designed to run as a systemd service.
1. Use `scripts/deploy.sh` to sync the project to `/opt/gasbuddy`.
2. The service file is located at `deploy/gasbuddy-dashboard.service`.
3. Use `journalctl -u gasbuddy-dashboard.service -f` to monitor logs.
