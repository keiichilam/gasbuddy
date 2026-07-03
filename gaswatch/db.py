from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import CITIES, DB_PATH


CITY_SLUGS_BY_LOCALITY = {
    " ".join(city.name.lower().split()): city.slug
    for city in CITIES
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS cities (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            province TEXT NOT NULL,
            url TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scan_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            status TEXT NOT NULL DEFAULT 'running',
            cities_requested INTEGER NOT NULL DEFAULT 0,
            cities_ok INTEGER NOT NULL DEFAULT 0,
            stations_seen INTEGER NOT NULL DEFAULT 0,
            prices_seen INTEGER NOT NULL DEFAULT 0,
            error TEXT
        );

        CREATE TABLE IF NOT EXISTS city_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
            city_slug TEXT NOT NULL REFERENCES cities(slug),
            fetched_at TEXT NOT NULL,
            status TEXT NOT NULL,
            station_count INTEGER NOT NULL DEFAULT 0,
            price_count INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            raw_json TEXT
        );

        CREATE TABLE IF NOT EXISTS stations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            brand TEXT,
            address_line1 TEXT,
            country TEXT,
            locality TEXT,
            province TEXT,
            postal_code TEXT,
            latitude REAL,
            longitude REAL,
            rating REAL,
            rating_count INTEGER,
            last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS station_cities (
            station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            city_slug TEXT NOT NULL REFERENCES cities(slug),
            PRIMARY KEY (station_id, city_slug)
        );

        CREATE TABLE IF NOT EXISTS price_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
            city_slug TEXT NOT NULL REFERENCES cities(slug),
            station_id TEXT NOT NULL REFERENCES stations(id),
            fuel_product TEXT NOT NULL,
            payment_type TEXT NOT NULL,
            price REAL NOT NULL,
            posted_at TEXT,
            nickname TEXT,
            observed_at TEXT NOT NULL,
            UNIQUE(scan_run_id, city_slug, station_id, fuel_product, payment_type)
        );

        CREATE TABLE IF NOT EXISTS city_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
            city_slug TEXT NOT NULL REFERENCES cities(slug),
            fuel_product TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            station_count INTEGER NOT NULL,
            min_price REAL,
            avg_price REAL,
            max_price REAL,
            UNIQUE(scan_run_id, city_slug, fuel_product)
        );

        CREATE INDEX IF NOT EXISTS idx_prices_city_fuel_time
            ON price_observations(city_slug, fuel_product, observed_at);
        CREATE INDEX IF NOT EXISTS idx_snapshots_city_fuel_time
            ON city_snapshots(city_slug, fuel_product, observed_at);

        CREATE TABLE IF NOT EXISTS db_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            email TEXT PRIMARY KEY,
            role TEXT NOT NULL DEFAULT 'user'
        );
        """
    )
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(stations)").fetchall()}
    if "country" not in columns:
        conn.execute("ALTER TABLE stations ADD COLUMN country TEXT")
    conn.execute(
        "INSERT OR IGNORE INTO users (email, role) VALUES (?, ?)",
        ("keiicilam@gmail.com", "admin")
    )
    conn.executemany(
        """
        INSERT INTO cities(slug, name, province, url)
        VALUES(:slug, :name, :province, :url)
        ON CONFLICT(slug) DO UPDATE SET
            name=excluded.name,
            province=excluded.province,
            url=excluded.url
        """,
        [city.__dict__ for city in CITIES],
    )
    reconcile_locality_city_groups(conn)
    conn.commit()


def get_user_role(conn: sqlite3.Connection, email: str) -> str:
    row = conn.execute("SELECT role FROM users WHERE email = ?", (email.lower(),)).fetchone()
    return row["role"] if row else "user"


def city_slug_for_locality(locality: str | None, fallback_slug: str) -> str:
    if not locality:
        return fallback_slug
    normalized = " ".join(locality.lower().split())
    return CITY_SLUGS_BY_LOCALITY.get(normalized, fallback_slug)


def reconcile_locality_city_groups(conn: sqlite3.Connection, *, force: bool = False) -> None:
    marker = "locality_city_groups_reconciled_v2"
    if not force and conn.execute("SELECT 1 FROM db_meta WHERE key = ?", (marker,)).fetchone():
        return

    mapped_stations = conn.execute(
        """
        SELECT s.id, c.slug AS locality_slug
        FROM stations s
        JOIN cities c ON lower(trim(s.locality)) = lower(c.name)
        """
    ).fetchall()
    for row in mapped_stations:
        station_id = row["id"]
        locality_slug = row["locality_slug"]
        conn.execute(
            """
            DELETE FROM price_observations
            WHERE station_id = ?
              AND city_slug <> ?
              AND EXISTS (
                  SELECT 1
                  FROM price_observations duplicate
                  WHERE duplicate.scan_run_id = price_observations.scan_run_id
                    AND duplicate.city_slug = ?
                    AND duplicate.station_id = price_observations.station_id
                    AND duplicate.fuel_product = price_observations.fuel_product
                    AND duplicate.payment_type = price_observations.payment_type
              )
            """,
            (station_id, locality_slug, locality_slug),
        )
        conn.execute(
            """
            UPDATE OR IGNORE price_observations
            SET city_slug = ?
            WHERE station_id = ? AND city_slug <> ?
            """,
            (locality_slug, station_id, locality_slug),
        )
        conn.execute(
            "DELETE FROM station_cities WHERE station_id = ? AND city_slug <> ?",
            (station_id, locality_slug),
        )
        conn.execute(
            "INSERT OR IGNORE INTO station_cities(station_id, city_slug) VALUES(?, ?)",
            (station_id, locality_slug),
        )

    conn.execute("DELETE FROM city_snapshots")
    conn.execute(
        """
        INSERT OR IGNORE INTO city_snapshots(
            scan_run_id, city_slug, fuel_product, observed_at, station_count,
            min_price, avg_price, max_price
        )
        SELECT
            scan_run_id, city_slug, fuel_product, MAX(observed_at),
            COUNT(DISTINCT station_id), MIN(price), AVG(price), MAX(price)
        FROM price_observations
        WHERE payment_type = 'credit'
        GROUP BY scan_run_id, city_slug, fuel_product
        """
    )
    conn.execute(
        """
        INSERT INTO db_meta(key, value) VALUES(?, '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (marker,),
    )


def start_scan(conn: sqlite3.Connection, cities_requested: int) -> int:
    cur = conn.execute(
        "INSERT INTO scan_runs(started_at, cities_requested) VALUES(?, ?)",
        (utc_now_iso(), cities_requested),
    )
    conn.commit()
    return int(cur.lastrowid)


def finish_scan(conn: sqlite3.Connection, scan_id: int, status: str, error: str | None = None) -> None:
    row = conn.execute(
        """
        SELECT
            COUNT(*) FILTER (WHERE status = 'ok') AS cities_ok,
            COALESCE(SUM(station_count), 0) AS stations_seen,
            COALESCE(SUM(price_count), 0) AS prices_seen
        FROM city_runs
        WHERE scan_run_id = ?
        """,
        (scan_id,),
    ).fetchone()
    conn.execute(
        """
        UPDATE scan_runs
        SET finished_at = ?, status = ?, cities_ok = ?, stations_seen = ?, prices_seen = ?, error = ?
        WHERE id = ?
        """,
        (
            utc_now_iso(),
            status,
            row["cities_ok"] or 0,
            row["stations_seen"] or 0,
            row["prices_seen"] or 0,
            error,
            scan_id,
        ),
    )
    conn.commit()


def record_city_error(
    conn: sqlite3.Connection,
    scan_id: int,
    city_slug: str,
    error: str,
    raw: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO city_runs(scan_run_id, city_slug, fetched_at, status, error, raw_json)
        VALUES(?, ?, ?, 'error', ?, ?)
        """,
        (scan_id, city_slug, utc_now_iso(), error, json.dumps(raw) if raw else None),
    )
    conn.commit()


def record_city_result(
    conn: sqlite3.Connection,
    scan_id: int,
    city_slug: str,
    stations: list[dict[str, Any]],
    raw: dict[str, Any],
) -> None:
    observed_at = utc_now_iso()
    price_count = 0
    stored_stations = 0
    stored_city_slugs: set[str] = set()

    for station in stations:
        if not is_bc_station(station):
            continue
        stored_stations += 1
        station_id = str(station["id"])
        address = station.get("address") or {}
        station_city_slug = city_slug_for_locality(address.get("locality"), city_slug)
        stored_city_slugs.add(station_city_slug)
        brands = station.get("brands") or []
        brand = brands[0].get("name") if brands else None
        conn.execute(
            """
            INSERT INTO stations(
                id, name, brand, address_line1, country, locality, province, postal_code,
                latitude, longitude, rating, rating_count, last_seen_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                brand=excluded.brand,
                address_line1=excluded.address_line1,
                country=excluded.country,
                locality=excluded.locality,
                province=excluded.province,
                postal_code=excluded.postal_code,
                latitude=excluded.latitude,
                longitude=excluded.longitude,
                rating=excluded.rating,
                rating_count=excluded.rating_count,
                last_seen_at=excluded.last_seen_at
            """,
            (
                station_id,
                station.get("name") or brand or "Unknown",
                brand,
                address.get("line1"),
                address.get("country"),
                address.get("locality"),
                address.get("region"),
                address.get("postalCode") or address.get("postal_code"),
                station.get("latitude"),
                station.get("longitude"),
                station.get("star_rating"),
                station.get("ratings_count"),
                observed_at,
            ),
        )
        conn.execute(
            "INSERT OR IGNORE INTO station_cities(station_id, city_slug) VALUES(?, ?)",
            (station_id, station_city_slug),
        )
        for report in station.get("prices") or []:
            fuel = report.get("fuel_product") or report.get("fuelProduct")
            if not fuel:
                continue
            for payment_type in ("cash", "credit"):
                price_data = report.get(payment_type)
                if not price_data or price_data.get("price") is None:
                    continue
                if float(price_data.get("price") or 0) <= 0:
                    continue
                conn.execute(
                    """
                    INSERT OR IGNORE INTO price_observations(
                        scan_run_id, city_slug, station_id, fuel_product, payment_type,
                        price, posted_at, nickname, observed_at
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        scan_id,
                        station_city_slug,
                        station_id,
                        fuel,
                        payment_type,
                        price_data.get("price"),
                        price_data.get("posted_time") or price_data.get("postedTime"),
                        price_data.get("nickname"),
                        observed_at,
                    ),
                )
                price_count += 1

    conn.execute(
        """
        INSERT INTO city_runs(
            scan_run_id, city_slug, fetched_at, status, station_count, price_count, raw_json
        )
        VALUES(?, ?, ?, 'ok', ?, ?, ?)
        """,
        (scan_id, city_slug, observed_at, stored_stations, price_count, json.dumps(raw)),
    )
    for stored_city_slug in stored_city_slugs:
        conn.execute(
            """
            INSERT OR IGNORE INTO city_snapshots(
                scan_run_id, city_slug, fuel_product, observed_at, station_count,
                min_price, avg_price, max_price
            )
            SELECT
                scan_run_id, city_slug, fuel_product, ?,
                COUNT(DISTINCT station_id), MIN(price), AVG(price), MAX(price)
            FROM price_observations
            WHERE scan_run_id = ? AND city_slug = ? AND payment_type = 'credit'
            GROUP BY scan_run_id, city_slug, fuel_product
            """,
            (observed_at, scan_id, stored_city_slug),
        )
    conn.commit()


def is_bc_station(station: dict[str, Any]) -> bool:
    address = station.get("address") or {}
    country = (address.get("country") or "").upper()
    region = (address.get("region") or "").upper()

    if not country and not region:
        return False
    if country and country not in {"CA", "CAN", "CANADA"}:
        return False
    if region and region not in {"BC", "BRITISH COLUMBIA"}:
        return False
    return True
