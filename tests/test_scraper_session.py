from __future__ import annotations

import unittest
from unittest import mock

from gaswatch import scraper
from gaswatch.config import CITIES


class GasBuddySessionTest(unittest.TestCase):
    def test_reuses_csrf_token_across_city_fetches(self) -> None:
        calls = {"csrf": 0, "post": 0}

        def fake_csrf(timeout: int) -> str:
            calls["csrf"] += 1
            return "token"

        def fake_post(payload: dict, timeout: int, csrf: str) -> dict:
            calls["post"] += 1
            self.assertEqual(csrf, "token")
            return {
                "data": {
                    "locationBySearchTerm": {
                        "stations": {"cursor": {"next": None}, "results": []}
                    }
                }
            }

        with mock.patch.object(scraper, "_get_csrf", side_effect=fake_csrf), mock.patch.object(
            scraper, "_post_json", side_effect=fake_post
        ):
            session = scraper.GasBuddySession()
            scraper.fetch_city(CITIES[0], session=session)
            scraper.fetch_city(CITIES[1], session=session)

        self.assertEqual(calls, {"csrf": 1, "post": 2})

    def test_token_403_retries(self) -> None:
        calls = {"csrf": 0}

        def fake_csrf(timeout: int) -> str:
            calls["csrf"] += 1
            if calls["csrf"] == 1:
                raise scraper.GasBuddyHTTPError(
                    403,
                    "blocked",
                    context="GasBuddy token",
                    retryable=True,
                )
            return "token"

        with mock.patch.object(scraper, "_get_csrf", side_effect=fake_csrf), mock.patch.object(
            scraper.time, "sleep"
        ) as sleep:
            session = scraper.GasBuddySession(retries=2, retry_delay=5)
            self.assertEqual(session.csrf_token(), "token")

        self.assertEqual(calls["csrf"], 2)
        sleep.assert_called_once_with(5)


if __name__ == "__main__":
    unittest.main()
