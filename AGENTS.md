# Repository Guidelines

## Project Structure & Module Organization

This Python and static-frontend project collects Lower Mainland GasBuddy prices into SQLite and serves a local dashboard.

- `scan.py` is the CLI entry point for collection.
- `dashboard.py` serves the dashboard and JSON API.
- `gaswatch/` contains shared Python modules: configuration, database setup, and scraper logic.
- `static/` contains the browser UI (`index.html`, `styles.css`, `app.js`).
- `data/` stores SQLite database and WAL files; treat these as local runtime artifacts.
- `logs/` stores scan logs.
- `scripts/` and `deploy/` contain cron and systemd deployment helpers.
- `gaswatch-*.png` files are dashboard screenshots/reference assets.

## Build, Test, and Development Commands

- `make check`: compile-check Python and run `node --check static/app.js`.
- `make scan`: run a default collection scan with conservative rate limits.
- `python3 scan.py --city richmond --max-pages 1`: run a focused scan while developing scraper changes.
- `make dashboard`: start the dashboard on Makefile `HOST`/`PORT`.
- `python3 dashboard.py --host 127.0.0.1 --port 20443`: start explicitly.
- `make health`: call `/api/health` on the running dashboard.
- `make cron`: install the hourly scan cron job via `scripts/install_cron.sh`.

## Coding Style & Naming Conventions

Use Python 3 with 4-space indentation, type hints where practical, and small functions with explicit return values. Keep configuration constants in `gaswatch/config.py`, database mutations in `gaswatch/db.py`, and GasBuddy request/parsing behavior in `gaswatch/scraper.py`. Use snake_case for Python names and slugs such as `new-westminster` for URL-facing identifiers. Frontend code uses plain JavaScript, camelCase variables, and direct DOM helpers.

## Testing Guidelines

Run `make check` before submitting changes; it performs Python compile checks, JavaScript syntax validation, and `unittest` discovery under `tests/`. For database or API changes, also start the dashboard and verify `make health`, `/api/summary`, and the affected endpoint manually. For scraper changes, prefer mocked unit tests or a single-city scan to avoid unnecessary GasBuddy traffic.

## Commit & Pull Request Guidelines

Git history is not available in this working copy, so no repository-specific convention can be inferred. Use short, imperative commit subjects such as `Add station trend endpoint` or `Fix Richmond scan filtering`. Pull requests should include a concise summary, commands run, manual dashboard/API checks, and screenshots when the visible dashboard changes.

## Security & Configuration Tips

Do not commit local databases, WAL files, logs, virtual environments, or secrets. Runtime settings use `GASWATCH_*` environment variables; document any new variable in `README.md` and keep defaults conservative to reduce rate limiting.
