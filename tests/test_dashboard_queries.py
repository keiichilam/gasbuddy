from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import dashboard
from dashboard import latest_prices, station_trends
from gaswatch.db import init_db


class DashboardQueryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        init_db(self.conn)
        self.conn.execute(
            """
            INSERT INTO stations(
                id, name, brand, address_line1, country, locality, province,
                postal_code, latitude, longitude, rating, rating_count, last_seen_at
            )
            VALUES('s1', 'Station One', 'Brand One', '1 Test Ave', 'CA', 'Richmond',
                   'BC', 'V0V 0V0', 49.1, -123.1, NULL, NULL, '2026-05-08T00:00:00+00:00')
            """
        )
        self.conn.execute(
            """
            INSERT INTO stations(
                id, name, brand, address_line1, country, locality, province,
                postal_code, latitude, longitude, rating, rating_count, last_seen_at
            )
            VALUES('s2', 'Station Two', 'Brand Two', '2 Test Ave', 'CA', 'Richmond',
                   'BC', 'V0V 0V0', 49.1, -123.1, NULL, NULL, '2026-05-08T00:00:00+00:00')
            """
        )
        self.conn.execute(
            "INSERT INTO station_cities(station_id, city_slug) VALUES('s1', 'richmond')"
        )
        self.conn.execute(
            "INSERT INTO station_cities(station_id, city_slug) VALUES('s2', 'richmond')"
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
            VALUES(1, 'richmond', 's1', 'regular_gas', ?, ?, '2026-05-08T00:00:00+00:00',
                   '2026-05-08T00:01:00+00:00')
            """,
            [("cash", 199.9), ("credit", 201.9)],
        )
        self.conn.execute(
            """
            INSERT INTO price_observations(
                scan_run_id, city_slug, station_id, fuel_product, payment_type,
                price, posted_at, observed_at
            )
            VALUES(1, 'richmond', 's1', 'premium_gas', 'credit', 219.9,
                   '2026-05-08T00:00:00+00:00', '2026-05-08T00:01:00+00:00')
            """
        )
        self.conn.execute(
            """
            INSERT INTO price_observations(
                scan_run_id, city_slug, station_id, fuel_product, payment_type,
                price, posted_at, observed_at
            )
            VALUES(1, 'richmond', 's2', 'regular_gas', 'credit', 209.9,
                   '2026-05-08T00:00:00+00:00', '2026-05-08T00:01:00+00:00')
            """
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    def test_latest_prices_includes_station_id(self) -> None:
        # cash prices are excluded; only credit: s1 regular, s1 premium, s2 regular
        rows = latest_prices(self.conn, "richmond")["stations"]

        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["station_id"], "s1")

    def test_latest_prices_can_filter_by_fuel(self) -> None:
        # cash prices are excluded; only credit regular: s1, s2
        rows = latest_prices(self.conn, "richmond", "regular_gas")["stations"]

        self.assertEqual(len(rows), 2)
        self.assertEqual({row["fuel_product"] for row in rows}, {"regular_gas"})

    def test_station_trends_uses_lowest_price_per_station_time(self) -> None:
        # station_trends filters to credit only; s1 credit regular = 201.9
        points = station_trends(self.conn, ["richmond"], 8760, "regular_gas")["points"]

        self.assertEqual(len(points), 2)
        self.assertEqual(points[0]["station_id"], "s1")
        self.assertEqual(points[0]["price"], 201.9)

    def test_station_trends_can_filter_by_station_id(self) -> None:
        points = station_trends(self.conn, ["richmond"], 8760, "regular_gas", "s2")["points"]

        self.assertEqual(len(points), 1)
        self.assertEqual(points[0]["station_id"], "s2")



class LoyaltyProgramConfigTest(unittest.TestCase):
    def _programs(self, discount: float = 3.0) -> dict:
        return {
            "programs": [
                {
                    "id": "test_rewards",
                    "name": "Test Rewards",
                    "description": "Test discount",
                    "discount_cpl": discount,
                    "brands": ["test brand"],
                },
                {
                    "id": "weekday_rewards",
                    "name": "Weekday Rewards",
                    "description": "Monday only",
                    "discount_cpl": 4.0,
                    "brands": ["weekday"],
                    "weekdays": [0],
                },
            ]
        }

    def _write_json(self, path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def test_loads_default_loyalty_programs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            default_path = base / "loyalty.json"
            runtime_path = base / "data" / "loyalty.json"
            self._write_json(default_path, self._programs())

            with (
                patch.object(dashboard, "DEFAULT_LOYALTY_PATH", default_path),
                patch.object(dashboard, "RUNTIME_LOYALTY_PATH", runtime_path),
            ):
                programs = dashboard.load_loyalty_programs()

        self.assertEqual(programs[0]["id"], "test_rewards")
        self.assertEqual(programs[0]["discount_cpl"], 3.0)

    def test_runtime_loyalty_programs_override_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            default_path = base / "loyalty.json"
            runtime_path = base / "data" / "loyalty.json"
            self._write_json(default_path, self._programs(3.0))
            self._write_json(runtime_path, self._programs(7.0))

            with (
                patch.object(dashboard, "DEFAULT_LOYALTY_PATH", default_path),
                patch.object(dashboard, "RUNTIME_LOYALTY_PATH", runtime_path),
            ):
                programs = dashboard.load_loyalty_programs()

        self.assertEqual(programs[0]["discount_cpl"], 7.0)

    def test_invalid_loyalty_save_does_not_overwrite_runtime_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            default_path = base / "loyalty.json"
            runtime_path = base / "data" / "loyalty.json"
            original = self._programs(5.0)
            self._write_json(default_path, self._programs(3.0))
            self._write_json(runtime_path, original)

            with (
                patch.object(dashboard, "DEFAULT_LOYALTY_PATH", default_path),
                patch.object(dashboard, "RUNTIME_LOYALTY_PATH", runtime_path),
            ):
                with self.assertRaises(ValueError):
                    dashboard.save_loyalty_programs({"programs": [{"id": "bad id"}]})
                programs = dashboard.load_loyalty_programs()

        self.assertEqual(programs[0]["discount_cpl"], 5.0)


    def test_parse_loyalty_param_filters_unknown_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            default_path = base / "loyalty.json"
            runtime_path = base / "data" / "loyalty.json"
            self._write_json(default_path, self._programs())

            with (
                patch.object(dashboard, "DEFAULT_LOYALTY_PATH", default_path),
                patch.object(dashboard, "RUNTIME_LOYALTY_PATH", runtime_path),
            ):
                parsed = dashboard.parse_loyalty_param({"loyalty": ["test_rewards,unknown_rewards"]})

        self.assertEqual(parsed, ["test_rewards"])

    def test_save_cars_drops_unknown_loyalty_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            default_path = base / "loyalty.json"
            runtime_path = base / "data" / "loyalty.json"
            cars_path = base / "cars.json"
            self._write_json(default_path, self._programs())
            cfg = {
                "home": {"lat": 49.0, "lng": -123.0, "label": "Home"},
                "fuel": "regular_gas",
                "include_victoria": True,
                "cars": [{"name": "Car", "l_per_100km": 8.0, "tank_litres": 50}],
                "loyalty_programs": ["test_rewards", "unknown_rewards"],
            }

            with (
                patch.object(dashboard, "DEFAULT_LOYALTY_PATH", default_path),
                patch.object(dashboard, "RUNTIME_LOYALTY_PATH", runtime_path),
                patch.object(dashboard, "CARS_PATH", cars_path),
            ):
                dashboard.save_cars(cfg)

            saved = json.loads(cars_path.read_text())

        self.assertEqual(saved["loyalty_programs"], ["test_rewards"])

    def test_loyalty_discount_uses_loaded_json_definition(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            default_path = base / "loyalty.json"
            runtime_path = base / "data" / "loyalty.json"
            self._write_json(default_path, self._programs(6.0))

            with (
                patch.object(dashboard, "DEFAULT_LOYALTY_PATH", default_path),
                patch.object(dashboard, "RUNTIME_LOYALTY_PATH", runtime_path),
            ):
                discount = dashboard._loyalty_discount("Test Brand Fuel", ["test_rewards"])

        self.assertEqual(discount, 6.0)



class GoogleAuthTest(unittest.TestCase):
    def test_auth_disabled_without_google_client_credentials(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(dashboard.auth_enabled())

    def test_session_token_verifies_and_expires(self) -> None:
        with patch.dict(os.environ, {"GASWATCH_GOOGLE_CLIENT_SECRET": "secret"}, clear=True):
            token = dashboard.make_session_token("USER@gmail.com", now=100)
            self.assertEqual(dashboard.verify_session_token(token, now=101), {"email": "user@gmail.com"})
            self.assertIsNone(dashboard.verify_session_token(token, now=100 + dashboard.AUTH_SESSION_TTL + 1))
            self.assertIsNone(dashboard.verify_session_token(token + "x", now=101))

    def test_oauth_state_token_preserves_safe_next_path(self) -> None:
        with patch.dict(os.environ, {"GASWATCH_GOOGLE_CLIENT_SECRET": "secret"}, clear=True):
            token = dashboard.make_oauth_state_token("state123", "/api/health?x=1", now=100)
            self.assertEqual(dashboard.verify_oauth_state_token(token, "state123", now=101), "/api/health?x=1")
            self.assertIsNone(dashboard.verify_oauth_state_token(token, "other", now=101))

    def test_google_auth_url_uses_configured_redirect(self) -> None:
        env = {
            "GASWATCH_GOOGLE_CLIENT_ID": "client-id",
            "GASWATCH_GOOGLE_CLIENT_SECRET": "secret",
            "GASWATCH_GOOGLE_REDIRECT_URI": "https://gas.keifu.ca/auth/google/callback",
        }
        with patch.dict(os.environ, env, clear=True):
            url = dashboard.google_auth_url("abc")

        self.assertIn("client_id=client-id", url)
        self.assertIn("redirect_uri=https%3A%2F%2Fgas.keifu.ca%2Fauth%2Fgoogle%2Fcallback", url)
        self.assertIn("state=abc", url)

    def test_google_user_allowed_requires_verified_email(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(dashboard.google_user_allowed({"email": "user@gmail.com", "email_verified": False}))
            self.assertTrue(dashboard.google_user_allowed({"email": "user@gmail.com", "email_verified": True}))

    def test_google_user_allowed_can_restrict_to_emails(self) -> None:
        with patch.dict(os.environ, {"GASWATCH_ALLOWED_EMAILS": "owner@gmail.com"}, clear=True):
            self.assertTrue(dashboard.google_user_allowed({"email": "owner@gmail.com", "email_verified": True}))
            self.assertFalse(dashboard.google_user_allowed({"email": "other@gmail.com", "email_verified": True}))

    def test_google_user_allowed_can_restrict_to_domains(self) -> None:
        with patch.dict(os.environ, {"GASWATCH_ALLOWED_DOMAINS": "gmail.com"}, clear=True):
            self.assertTrue(dashboard.google_user_allowed({"email": "owner@gmail.com", "email_verified": True}))
            self.assertFalse(dashboard.google_user_allowed({"email": "owner@example.com", "email_verified": True}))

    def test_unauthenticated_page_request_redirects_to_login(self) -> None:
        class Handler(dashboard.DashboardHandler):
            def __init__(self) -> None:
                self.path = "/"
                self.headers = {}
                self.redirect_location = None

            def redirect(self, location: str, *, cookies_to_set=None) -> None:
                self.redirect_location = location

        env = {
            "GASWATCH_GOOGLE_CLIENT_ID": "client-id",
            "GASWATCH_GOOGLE_CLIENT_SECRET": "secret",
        }
        with patch.dict(os.environ, env, clear=True):
            handler = Handler()
            handler.do_HEAD()

        self.assertEqual(handler.redirect_location, "/auth/login?next=%2F")

    def test_unauthenticated_api_request_returns_401(self) -> None:
        class Handler(dashboard.DashboardHandler):
            def __init__(self) -> None:
                self.path = "/api/health"
                self.headers = {}
                self.json_status = None
                self.json_body = None

            def send_json(self, data, status: int = 200) -> None:
                self.json_body = data
                self.json_status = status

        env = {
            "GASWATCH_GOOGLE_CLIENT_ID": "client-id",
            "GASWATCH_GOOGLE_CLIENT_SECRET": "secret",
        }
        with patch.dict(os.environ, env, clear=True):
            handler = Handler()
            handler.do_HEAD()

        self.assertEqual(handler.json_status, 401)
        self.assertEqual(handler.json_body, {"error": "authentication required"})


class RoleBasedAuthTest(unittest.TestCase):
    def setUp(self) -> None:
        self.db_fd, self.db_path = tempfile.mkstemp()
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        init_db(self.conn)
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_is_admin_returns_true_for_seeded_admin(self) -> None:
        class Handler(dashboard.DashboardHandler):
            def __init__(self, db_path: Path) -> None:
                self.db_path = db_path
                self.headers = {"Cookie": dashboard.AUTH_SESSION_COOKIE + "=token"}

        with (
            patch.dict(os.environ, {"GASWATCH_GOOGLE_CLIENT_ID": "id", "GASWATCH_GOOGLE_CLIENT_SECRET": "secret"}, clear=True),
            patch("dashboard.verify_session_token", return_value={"email": "keiicilam@gmail.com"}),
        ):
            handler = Handler(Path(self.db_path))
            self.assertTrue(handler.is_admin())

    def test_is_admin_returns_false_for_standard_user(self) -> None:
        class Handler(dashboard.DashboardHandler):
            def __init__(self, db_path: Path) -> None:
                self.db_path = db_path
                self.headers = {"Cookie": dashboard.AUTH_SESSION_COOKIE + "=token"}

        with (
            patch.dict(os.environ, {"GASWATCH_GOOGLE_CLIENT_ID": "id", "GASWATCH_GOOGLE_CLIENT_SECRET": "secret"}, clear=True),
            patch("dashboard.verify_session_token", return_value={"email": "other@gmail.com"}),
        ):
            handler = Handler(Path(self.db_path))
            self.assertFalse(handler.is_admin())

    def test_is_admin_returns_true_if_auth_disabled(self) -> None:
        class Handler(dashboard.DashboardHandler):
            def __init__(self) -> None:
                pass

        with patch.dict(os.environ, {}, clear=True):
            handler = Handler()
            self.assertTrue(handler.is_admin())


if __name__ == "__main__":
    unittest.main()
