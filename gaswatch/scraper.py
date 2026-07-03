from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .config import City


GRAPHQL_URL = "https://www.gasbuddy.com/graphql"

LOCATION_QUERY = """
query LocationBySearchTerm($brandId: Int, $cursor: String, $fuel: Int, $lat: Float, $lng: Float, $maxAge: Int, $search: String) {
  locationBySearchTerm(lat: $lat, lng: $lng, search: $search) {
    stations(brandId: $brandId cursor: $cursor fuel: $fuel lat: $lat lng: $lng maxAge: $maxAge) {
      count
      cursor { next }
      results {
        address { country line1 locality postalCode region }
        id
        name
        prices {
          cash { nickname postedTime price }
          credit { nickname postedTime price }
          fuelProduct
          longName
        }
        latitude
        longitude
        priceUnit
        currency
      }
    }
    trends { areaName country today todayLow trend }
  }
}
"""

CSRF_PATTERN = re.compile(r'window\.gbcsrf\s*=\s*(["\'])(.*?)\1')


@dataclass
class FetchResult:
    city: City
    raw: dict[str, Any]
    stations: list[dict[str, Any]]


class GasBuddyError(RuntimeError):
    pass


class GasBuddyHTTPError(GasBuddyError):
    def __init__(
        self,
        status_code: int,
        detail: str,
        context: str = "GasBuddy",
        retryable: bool | None = None,
    ) -> None:
        self.status_code = status_code
        self.detail = detail
        self.retryable = retryable if retryable is not None else status_code == 429 or 500 <= status_code < 600
        super().__init__(f"{context} HTTP {status_code}: {detail}")


def _retry_call(label: str, retries: int, retry_delay: float, func):
    attempt = 0
    while True:
        try:
            return func()
        except GasBuddyHTTPError as exc:
            if not exc.retryable or attempt >= retries:
                raise
            attempt += 1
            time.sleep(retry_delay * attempt)
        except GasBuddyError:
            raise


@dataclass
class GasBuddySession:
    timeout: int = 30
    retries: int = 2
    retry_delay: float = 30.0
    csrf: str | None = None

    def csrf_token(self, refresh: bool = False) -> str:
        if refresh or not self.csrf:
            self.csrf = _retry_call(
                "csrf",
                self.retries,
                self.retry_delay,
                lambda: _get_csrf(self.timeout),
            )
        return self.csrf

    def post_json(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return _retry_call(
                "graphql",
                self.retries,
                self.retry_delay,
                lambda: _post_json(payload, timeout=self.timeout, csrf=self.csrf_token()),
            )
        except GasBuddyHTTPError as exc:
            if exc.status_code not in {401, 403}:
                raise
            return _retry_call(
                "graphql",
                self.retries,
                self.retry_delay,
                lambda: _post_json(payload, timeout=self.timeout, csrf=self.csrf_token(refresh=True)),
            )


def _get_csrf(timeout: int) -> str:
    request = urllib.request.Request(
        "https://www.gasbuddy.com/home",
        method="GET",
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
            ),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            html = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise GasBuddyHTTPError(
            exc.code,
            detail,
            context="GasBuddy token",
            retryable=exc.code in {403, 429} or 500 <= exc.code < 600,
        ) from exc
    except urllib.error.URLError as exc:
        raise GasBuddyError(f"GasBuddy token request failed: {exc.reason}") from exc

    match = CSRF_PATTERN.search(html)
    if not match:
        raise GasBuddyError("GasBuddy CSRF token not found on /home")
    return match.group(2)


def _post_json(payload: dict[str, Any], timeout: int, csrf: str) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        GRAPHQL_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Sec-Fetch-Dest": "",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "Priority": "u=0",
            "apollo-require-preflight": "true",
            "gbcsrf": csrf,
            "Origin": "https://www.gasbuddy.com",
            "Referer": "https://www.gasbuddy.com/home",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
            ),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise GasBuddyHTTPError(exc.code, detail) from exc
    except urllib.error.URLError as exc:
        raise GasBuddyError(f"GasBuddy request failed: {exc.reason}") from exc

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise GasBuddyError(f"GasBuddy returned non-JSON response: {text[:200]}") from exc


def fetch_city(
    city: City,
    max_age_hours: int = 0,
    timeout: int = 30,
    max_pages: int = 1,
    page_delay: float = 2.0,
    retries: int = 2,
    retry_delay: float = 30.0,
    session: GasBuddySession | None = None,
) -> FetchResult:
    stations: list[dict[str, Any]] = []
    cursor: str | None = None
    first_raw: dict[str, Any] | None = None
    client = session or GasBuddySession(timeout=timeout, retries=retries, retry_delay=retry_delay)
    page = 0

    while True:
        page += 1
        payload = {
            "operationName": "LocationBySearchTerm",
            "variables": {
                "brandId": None,
                "cursor": cursor,
                "fuel": 1,
                "lat": city.latitude,
                "lng": city.longitude,
                "maxAge": max_age_hours,
                "search": None,
            },
            "query": LOCATION_QUERY,
        }
        raw = client.post_json(payload)
        if first_raw is None:
            first_raw = raw
        if raw.get("errors"):
            raise GasBuddyError(json.dumps(raw["errors"])[:500])
        location = (raw.get("data") or {}).get("locationBySearchTerm")
        if not location:
            raise GasBuddyError("No locationBySearchTerm data in GasBuddy response")
        station_page = location.get("stations") or {}
        stations.extend(station_page.get("results") or [])
        cursor = (station_page.get("cursor") or {}).get("next")
        if not cursor or page >= max_pages:
            break
        time.sleep(page_delay)

    return FetchResult(city=city, raw=first_raw or {}, stations=stations)
