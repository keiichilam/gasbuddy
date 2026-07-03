"""Tests for trip_prices() and nearby_prices()."""
from __future__ import annotations

import datetime
import sqlite3
import unittest
from unittest.mock import patch

import dashboard
from dashboard import nearby_prices, trip_prices
from gaswatch.db import init_db
from gaswatch.routing import haversine_km


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


class TripCalculatorTest(unittest.TestCase):
    """
    Layout
    ------
    home = (49.0, -123.0)
    dest = (49.1, -123.0)   ~11 km due north

    on_cheap  (49.05, -123.0)  — on route, no detour,  200.9 ¢/L, Generic
    on_petro  (49.05, -123.0)  — on route, no detour,  203.5 ¢/L, Petro-Canada (-3¢ loyalty)
    off_route (49.05, -123.3)  — large westward detour, 199.9 ¢/L, Generic
    domo_st   (49.05, -123.0)  — on route,              202.0 ¢/L, Domo (-4¢ Mon/Thu only)
    """

    HOME = (49.0, -123.0)
    DEST = (49.1, -123.0)

    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        init_db(self.conn)

        now = _now()
        self.conn.execute(
            "INSERT INTO scan_runs(id, started_at, finished_at, status, cities_requested) "
            f"VALUES(1, '{now}', '{now}', 'ok', 1)"
        )
        stations = [
            ("on_cheap",  "Cheap Generic",  "Generic",       49.05, -123.0),
            ("on_petro",  "Petro Station",  "Petro-Canada",  49.05, -123.0),
            ("off_route", "Off Route",      "Generic",       49.05, -123.3),
            ("domo_st",   "Domo Station",   "Domo",          49.05, -123.0),
        ]
        self.conn.executemany(
            "INSERT INTO stations(id, name, brand, address_line1, country, locality, province, "
            "postal_code, latitude, longitude, rating, rating_count, last_seen_at) "
            f"VALUES(?, ?, ?, '1 St', 'CA', 'Richmond', 'BC', 'V0V', ?, ?, NULL, NULL, '{now}')",
            stations,
        )
        self.conn.executemany(
            "INSERT INTO station_cities(station_id, city_slug) VALUES(?, 'richmond')",
            [(sid,) for sid, *_ in stations],
        )
        prices = [("on_cheap", 200.9), ("on_petro", 203.5), ("off_route", 199.9), ("domo_st", 202.0)]
        self.conn.executemany(
            "INSERT INTO price_observations(scan_run_id, city_slug, station_id, fuel_product, "
            f"payment_type, price, posted_at, observed_at) "
            f"VALUES(1, 'richmond', ?, 'regular_gas', 'credit', ?, '{now}', '{now}')",
            prices,
        )
        self.conn.execute(
            "INSERT INTO price_observations(scan_run_id, city_slug, station_id, fuel_product, "
            f"payment_type, price, posted_at, observed_at) "
            f"VALUES(1, 'richmond', 'on_petro', 'regular_gas', 'cash', 198.5, '{now}', '{now}')"
        )
        self.conn.execute(
            "INSERT INTO price_observations(scan_run_id, city_slug, station_id, fuel_product, "
            f"payment_type, price, posted_at, observed_at) "
            f"VALUES(1, 'vancouver', 'on_petro', 'regular_gas', 'credit', 203.5, '{now}', '{now}')"
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    def _calc(self, loyalty=None):
        return trip_prices(
            self.conn,
            *self.HOME, *self.DEST,
            fuel="regular_gas",
            l_per_100km=10.0,
            fill_litres=40.0,
            max_age_hours=1,
            loyalty_programs=loyalty or [],
        )

    # ── Basic structure ──────────────────────────────────────

    def test_returns_stations(self):
        self.assertGreater(len(self._calc()["stations"]), 0)

    def test_excludes_cash_price_at_latest_credit_time(self):
        stations = {s["station_id"]: s for s in self._calc()["stations"]}
        self.assertEqual(stations["on_petro"]["price"], 203.5)

    def test_deduplicates_station_observed_in_multiple_cities(self):
        ids = [s["station_id"] for s in self._calc()["stations"]]
        self.assertEqual(ids.count("on_petro"), 1)

    def test_result_has_metadata(self):
        result = self._calc()
        for key in ("direct_km", "home", "dest", "fuel", "station_count"):
            self.assertIn(key, result)
        self.assertGreater(result["direct_km"], 0)

    def test_home_to_station_km_populated(self):
        for s in self._calc()["stations"]:
            self.assertIn("home_to_station_km", s)
            self.assertGreaterEqual(s["home_to_station_km"], 0)

    def test_loyalty_discount_cpl_field_present(self):
        for s in self._calc()["stations"]:
            self.assertIn("loyalty_discount_cpl", s)

    # ── Detour math ──────────────────────────────────────────

    def test_on_route_station_has_zero_detour(self):
        stations = {s["station_id"]: s for s in self._calc()["stations"]}
        self.assertEqual(stations["on_cheap"]["detour_km"], 0.0)

    def test_off_route_station_has_positive_detour(self):
        stations = {s["station_id"]: s for s in self._calc()["stations"]}
        self.assertGreater(stations["off_route"]["detour_km"], 0.0)

    def test_off_route_ranks_below_on_route_despite_lower_pump_price(self):
        # off_route pump price (199.9) is cheaper than on_cheap (200.9),
        # but its large detour makes effective_cpl higher.
        ids = [s["station_id"] for s in self._calc()["stations"]]
        self.assertLess(ids.index("on_cheap"), ids.index("off_route"))

    def test_sorted_by_effective_cpl(self):
        cpls = [s["effective_cpl"] for s in self._calc()["stations"]]
        self.assertEqual(cpls, sorted(cpls))

    def test_round_trip_via_home_counts_both_legs(self):
        # dest == home models a "fill up and return home" trip (used by trip.py)
        result = trip_prices(
            self.conn,
            *self.HOME, *self.HOME,
            fuel="regular_gas",
            l_per_100km=10.0,
            fill_litres=40.0,
            max_age_hours=1,
        )
        self.assertEqual(result["direct_km"], 0.0)
        stations = {s["station_id"]: s for s in result["stations"]}
        s = stations["on_cheap"]
        self.assertAlmostEqual(s["detour_km"], 2 * s["home_to_station_km"], places=1)

    def test_remaining_range_flags_unreachable_station(self):
        stations = {s["station_id"]: s for s in trip_prices(
            self.conn,
            *self.HOME, *self.DEST,
            fuel="regular_gas",
            l_per_100km=10.0,
            fill_litres=40.0,
            max_age_hours=1,
            remaining_km=6.0,
        )["stations"]}
        self.assertFalse(stations["on_cheap"]["out_of_range"])
        self.assertTrue(stations["off_route"]["out_of_range"])

    # ── Loyalty discounts ────────────────────────────────────

    def test_no_discount_without_loyalty_program(self):
        stations = {s["station_id"]: s for s in self._calc()["stations"]}
        self.assertEqual(stations["on_petro"]["loyalty_discount_cpl"], 0.0)

    def test_loyalty_uses_best_matching_available_discount(self):
        programs = [
            {"id": "low", "name": "Low", "discount_cpl": 1.0, "brands": ["petro-canada"]},
            {"id": "high", "name": "High", "discount_cpl": 4.0, "brands": ["petro-canada"]},
        ]
        with patch.object(dashboard, "load_loyalty_programs", return_value=programs):
            self.assertEqual(dashboard._loyalty_discount("Petro-Canada", ["low", "high"]), 4.0)

    def test_loyalty_discount_applied_to_matching_brand(self):
        stations = {s["station_id"]: s for s in self._calc(loyalty=["petro_rbc"])["stations"]}
        self.assertEqual(stations["on_petro"]["loyalty_discount_cpl"], 3.0)

    def test_empty_weekdays_discount_is_always_active(self):
        programs = [
            {
                "id": "always",
                "name": "Always",
                "discount_cpl": 100.0,
                "brands": ["petro-canada"],
                "weekdays": [],
            },
        ]
        with patch.object(dashboard, "load_loyalty_programs", return_value=programs):
            self.assertEqual(dashboard._loyalty_discount("Petro-Canada", ["always"]), 100.0)

    def test_loyalty_discount_not_applied_to_non_matching_brand(self):
        stations = {s["station_id"]: s for s in self._calc(loyalty=["petro_rbc"])["stations"]}
        self.assertEqual(stations["on_cheap"]["loyalty_discount_cpl"], 0.0)

    def test_loyalty_lowers_effective_cpl(self):
        base = {s["station_id"]: s for s in self._calc()["stations"]}
        disc = {s["station_id"]: s for s in self._calc(loyalty=["petro_rbc"])["stations"]}
        self.assertLess(disc["on_petro"]["effective_cpl"], base["on_petro"]["effective_cpl"])

    def test_loyalty_changes_ranking(self):
        # Without loyalty: on_petro (203.5) ranks below on_cheap (200.9)
        ids_no = [s["station_id"] for s in self._calc()["stations"]]
        self.assertLess(ids_no.index("on_cheap"), ids_no.index("on_petro"))

        # With petro_rbc: on_petro adjusted to 200.5 → ranks above on_cheap (200.9)
        ids_yes = [s["station_id"] for s in self._calc(loyalty=["petro_rbc"])["stations"]]
        self.assertLess(ids_yes.index("on_petro"), ids_yes.index("on_cheap"))

    # ── Domo date-aware discount ─────────────────────────────

    def test_domo_discount_applied_on_monday(self):
        monday = datetime.date(2026, 5, 18)
        with patch("dashboard.datetime") as m:
            m.date.today.return_value = monday
            stations = {s["station_id"]: s for s in self._calc(loyalty=["domo"])["stations"]}
        self.assertEqual(stations["domo_st"]["loyalty_discount_cpl"], 4.0)

    def test_domo_discount_applied_on_thursday(self):
        thursday = datetime.date(2026, 5, 21)
        with patch("dashboard.datetime") as m:
            m.date.today.return_value = thursday
            stations = {s["station_id"]: s for s in self._calc(loyalty=["domo"])["stations"]}
        self.assertEqual(stations["domo_st"]["loyalty_discount_cpl"], 4.0)

    def test_domo_no_discount_on_wednesday(self):
        wednesday = datetime.date(2026, 5, 20)
        with patch("dashboard.datetime") as m:
            m.date.today.return_value = wednesday
            stations = {s["station_id"]: s for s in self._calc(loyalty=["domo"])["stations"]}
        self.assertEqual(stations["domo_st"]["loyalty_discount_cpl"], 0.0)

    def test_domo_no_discount_on_saturday(self):
        saturday = datetime.date(2026, 5, 23)
        with patch("dashboard.datetime") as m:
            m.date.today.return_value = saturday
            stations = {s["station_id"]: s for s in self._calc(loyalty=["domo"])["stations"]}
        self.assertEqual(stations["domo_st"]["loyalty_discount_cpl"], 0.0)


class NearbyPricesTest(unittest.TestCase):
    """
    Layout
    ------
    query = (49.05, -123.0)

    near  (49.050, -123.0)   — 0 km,   205.9 ¢/L, Chevron (Journie −5¢)
    mid   (49.055, -123.0)   — ~0.6 km, 202.0 ¢/L, Generic
    far   (49.500, -123.0)   — ~50 km,  195.0 ¢/L, Generic
    """

    QUERY = (49.05, -123.0)

    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        init_db(self.conn)

        now = _now()
        self.conn.execute(
            "INSERT INTO scan_runs(id, started_at, finished_at, status, cities_requested) "
            f"VALUES(1, '{now}', '{now}', 'ok', 1)"
        )
        stations = [
            ("near", "Near Station", "Chevron", 49.050, -123.0),
            ("mid",  "Mid Station",  "Generic", 49.055, -123.0),
            ("far",  "Far Station",  "Generic", 49.500, -123.0),
        ]
        self.conn.executemany(
            "INSERT INTO stations(id, name, brand, address_line1, country, locality, province, "
            "postal_code, latitude, longitude, rating, rating_count, last_seen_at) "
            f"VALUES(?, ?, ?, '1 St', 'CA', 'Richmond', 'BC', 'V0V', ?, ?, NULL, NULL, '{now}')",
            stations,
        )
        self.conn.executemany(
            "INSERT INTO station_cities(station_id, city_slug) VALUES(?, 'richmond')",
            [(sid,) for sid, *_ in stations],
        )
        prices = [("near", 205.9), ("mid", 202.0), ("far", 195.0)]
        self.conn.executemany(
            "INSERT INTO price_observations(scan_run_id, city_slug, station_id, fuel_product, "
            f"payment_type, price, posted_at, observed_at) "
            f"VALUES(1, 'richmond', ?, 'regular_gas', 'credit', ?, '{now}', '{now}')",
            prices,
        )
        self.conn.execute(
            "INSERT INTO price_observations(scan_run_id, city_slug, station_id, fuel_product, "
            f"payment_type, price, posted_at, observed_at) "
            f"VALUES(1, 'richmond', 'near', 'regular_gas', 'cash', 199.9, '{now}', '{now}')"
        )
        self.conn.execute(
            "INSERT INTO price_observations(scan_run_id, city_slug, station_id, fuel_product, "
            f"payment_type, price, posted_at, observed_at) "
            f"VALUES(1, 'vancouver', 'near', 'regular_gas', 'credit', 205.9, '{now}', '{now}')"
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    def _nearby(self, radius_km=5, loyalty=None):
        return nearby_prices(
            self.conn, *self.QUERY,
            fuel="regular_gas",
            radius_km=radius_km,
            max_age_hours=1,
            loyalty_programs=loyalty or [],
        )

    def test_excludes_station_outside_radius(self):
        ids = {s["station_id"] for s in self._nearby(radius_km=5)["stations"]}
        self.assertNotIn("far", ids)

    def test_includes_station_inside_radius(self):
        ids = {s["station_id"] for s in self._nearby(radius_km=5)["stations"]}
        self.assertIn("near", ids)

    def test_excludes_cash_price_at_latest_credit_time(self):
        stations = {s["station_id"]: s for s in self._nearby()["stations"]}
        self.assertEqual(stations["near"]["price"], 205.9)

    def test_deduplicates_station_observed_in_multiple_cities(self):
        ids = [s["station_id"] for s in self._nearby()["stations"]]
        self.assertEqual(ids.count("near"), 1)

    def test_distance_km_populated(self):
        for s in self._nearby()["stations"]:
            self.assertIn("distance_km", s)
            self.assertGreaterEqual(s["distance_km"], 0)

    def test_remaining_range_ranks_reachable_station_first(self):
        ids = [s["station_id"] for s in nearby_prices(
            self.conn, *self.QUERY,
            fuel="regular_gas",
            radius_km=5,
            max_age_hours=1,
            remaining_km=0.1,
        )["stations"]]
        self.assertLess(ids.index("near"), ids.index("mid"))

    def test_small_fill_considers_station_travel_cost(self):
        stations = nearby_prices(
            self.conn, *self.QUERY,
            fuel="regular_gas",
            radius_km=5,
            max_age_hours=1,
            l_per_100km=10.0,
            fill_litres=1.0,
        )["stations"]
        self.assertEqual(stations[0]["station_id"], "near")
        self.assertGreater(stations[1]["effective_cpl"], stations[1]["price"])

    def test_travel_cost_is_round_trip(self):
        stations = {s["station_id"]: s for s in nearby_prices(
            self.conn, *self.QUERY,
            fuel="regular_gas",
            radius_km=5,
            max_age_hours=1,
            l_per_100km=10.0,
            fill_litres=1.0,
        )["stations"]}
        dist = haversine_km(*self.QUERY, 49.055, -123.0)
        extra_litres = 2 * dist * 0.1
        self.assertEqual(stations["mid"]["effective_cpl"], round((1 + extra_litres) * 202.0, 1))

    def test_loyalty_discount_zero_without_program(self):
        for s in self._nearby()["stations"]:
            self.assertEqual(s["loyalty_discount_cpl"], 0.0)

    def test_loyalty_discount_applied_to_chevron(self):
        stations = {s["station_id"]: s for s in self._nearby(loyalty=["journie"])["stations"]}
        self.assertEqual(stations["near"]["loyalty_discount_cpl"], 5.0)

    def test_loyalty_discount_not_applied_to_generic(self):
        stations = {s["station_id"]: s for s in self._nearby(loyalty=["journie"])["stations"]}
        self.assertEqual(stations["mid"]["loyalty_discount_cpl"], 0.0)

    def test_loyalty_improves_ranking(self):
        # Without loyalty: mid (202.0) ranks before near (205.9)
        ids_no = [s["station_id"] for s in self._nearby()["stations"]]
        self.assertLess(ids_no.index("mid"), ids_no.index("near"))

        # With journie: near adjusted to 200.9 → ranks before mid (202.0)
        ids_yes = [s["station_id"] for s in self._nearby(loyalty=["journie"])["stations"]]
        self.assertLess(ids_yes.index("near"), ids_yes.index("mid"))


if __name__ == "__main__":
    unittest.main()
