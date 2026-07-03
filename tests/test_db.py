from __future__ import annotations

import sqlite3
import unittest

from gaswatch.db import init_db, reconcile_locality_city_groups, record_city_result, start_scan, get_user_role


class DatabaseWriteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()

    def test_get_user_role_defaults_to_user(self) -> None:
        self.assertEqual(get_user_role(self.conn, "unknown@example.com"), "user")

    def test_get_user_role_returns_admin_for_seeded_user(self) -> None:
        self.assertEqual(get_user_role(self.conn, "keiicilam@gmail.com"), "admin")

    def test_record_city_result_groups_station_by_actual_locality(self) -> None:
        scan_id = start_scan(self.conn, 1)
        record_city_result(
            self.conn,
            scan_id,
            "richmond",
            [
                {
                    "id": "65556",
                    "name": "Esso",
                    "brands": [],
                    "address": {
                        "line1": "709 SW Marine Dr",
                        "country": "CA",
                        "locality": "Vancouver",
                        "region": "BC",
                        "postalCode": "V6P 3M3",
                    },
                    "latitude": 49.2101,
                    "longitude": -123.123,
                    "prices": [
                        {
                            "fuel_product": "regular_gas",
                            "credit": {
                                "price": 199.9,
                                "posted_time": "2026-05-08T00:00:00+00:00",
                            },
                        }
                    ],
                }
            ],
            {"test": True},
        )

        station_city = self.conn.execute(
            "SELECT city_slug FROM station_cities WHERE station_id = '65556'"
        ).fetchone()
        price_city = self.conn.execute(
            "SELECT city_slug FROM price_observations WHERE station_id = '65556'"
        ).fetchone()
        snapshots = self.conn.execute(
            "SELECT city_slug, station_count FROM city_snapshots WHERE scan_run_id = ?",
            (scan_id,),
        ).fetchall()

        self.assertEqual(station_city["city_slug"], "vancouver")
        self.assertEqual(price_city["city_slug"], "vancouver")
        self.assertEqual([dict(row) for row in snapshots], [{"city_slug": "vancouver", "station_count": 1}])

    def test_reconcile_removes_duplicate_price_rows_for_wrong_city(self) -> None:
        self.conn.execute(
            """
            INSERT INTO stations(
                id, name, brand, address_line1, country, locality, province,
                postal_code, latitude, longitude, rating, rating_count, last_seen_at
            )
            VALUES('115897', 'Chevron', NULL, '11614 96 Ave', 'CA', 'Delta',
                   'BC', 'V4C 3W7', 49.176, -122.900, NULL, NULL, '2026-05-08T00:00:00+00:00')
            """
        )
        self.conn.execute(
            "INSERT INTO station_cities(station_id, city_slug) VALUES('115897', 'new-westminster')"
        )
        self.conn.execute(
            "INSERT INTO scan_runs(id, started_at, finished_at, status, cities_requested) VALUES(1, '2026-05-08T00:00:00+00:00', '2026-05-08T00:01:00+00:00', 'ok', 1)"
        )
        self.conn.executemany(
            """
            INSERT INTO price_observations(
                scan_run_id, city_slug, station_id, fuel_product, payment_type,
                price, posted_at, observed_at
            )
            VALUES(1, ?, '115897', 'regular_gas', 'credit', ?, NULL,
                   '2026-05-08T00:01:00+00:00')
            """,
            [("new-westminster", 201.9), ("delta", 199.9)],
        )

        reconcile_locality_city_groups(self.conn, force=True)

        station_cities = self.conn.execute(
            "SELECT city_slug FROM station_cities WHERE station_id = '115897'"
        ).fetchall()
        price_cities = self.conn.execute(
            "SELECT city_slug, COUNT(*) AS rows FROM price_observations WHERE station_id = '115897' GROUP BY city_slug"
        ).fetchall()

        self.assertEqual([row["city_slug"] for row in station_cities], ["delta"])
        self.assertEqual([dict(row) for row in price_cities], [{"city_slug": "delta", "rows": 1}])


if __name__ == "__main__":
    unittest.main()
