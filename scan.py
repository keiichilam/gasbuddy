#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time

from gaswatch.config import (
    CITIES,
    DB_PATH,
    DEFAULT_CITY_DELAY,
    DEFAULT_MAX_AGE_HOURS,
    DEFAULT_MAX_PAGES,
    DEFAULT_PAGE_DELAY,
    DEFAULT_RETRIES,
    DEFAULT_RETRY_DELAY,
    DEFAULT_TIMEOUT,
    LOG_DIR,
)
from gaswatch.db import connect, finish_scan, init_db, record_city_error, record_city_result, start_scan
from gaswatch.scraper import GasBuddyError, GasBuddySession, fetch_city


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect Lower Mainland GasBuddy station prices.")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path.")
    parser.add_argument("--city", action="append", help="Limit scan to one or more city slugs.")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="HTTP timeout in seconds.")
    parser.add_argument("--max-age-hours", type=int, default=DEFAULT_MAX_AGE_HOURS, help="GasBuddy maxAge filter. 0 asks for current data.")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, help="Station pages to collect per city. Keep low to avoid rate limits.")
    parser.add_argument("--page-delay", type=float, default=DEFAULT_PAGE_DELAY, help="Delay between paginated GasBuddy requests.")
    parser.add_argument("--city-delay", type=float, default=DEFAULT_CITY_DELAY, help="Delay between city requests.")
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES, help="Retries for retryable GasBuddy HTTP failures.")
    parser.add_argument("--retry-delay", type=float, default=DEFAULT_RETRY_DELAY, help="Base retry delay in seconds.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    selected = CITIES
    if args.city:
        wanted = set(args.city)
        selected = [city for city in CITIES if city.slug in wanted]
        missing = wanted - {city.slug for city in selected}
        if missing:
            print(f"Unknown city slug(s): {', '.join(sorted(missing))}", file=sys.stderr)
            return 2

    conn = connect(DB_PATH if args.db == str(DB_PATH) else Path(args.db))
    init_db(conn)
    scan_id = start_scan(conn, len(selected))
    had_error = False
    session = GasBuddySession(timeout=args.timeout, retries=args.retries, retry_delay=args.retry_delay)

    try:
        for index, city in enumerate(selected):
            if index:
                time.sleep(args.city_delay)
            try:
                result = fetch_city(
                    city,
                    max_age_hours=args.max_age_hours,
                    timeout=args.timeout,
                    max_pages=args.max_pages,
                    page_delay=args.page_delay,
                    retries=args.retries,
                    retry_delay=args.retry_delay,
                    session=session,
                )
                record_city_result(conn, scan_id, city.slug, result.stations, result.raw)
                print(f"{city.name}: {len(result.stations)} stations")
            except GasBuddyError as exc:
                had_error = True
                record_city_error(conn, scan_id, city.slug, str(exc))
                print(f"{city.name}: ERROR {exc}", file=sys.stderr)

        finish_scan(conn, scan_id, "partial_error" if had_error else "ok")
        print(f"scan_id={scan_id}")
        return 1 if had_error else 0
    except Exception as exc:
        finish_scan(conn, scan_id, "error", str(exc))
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
