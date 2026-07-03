"""Road distance matrix via OSRM Table API, with haversine fallback."""
from __future__ import annotations

import json
import logging
import math
import os
import urllib.error
import urllib.request

_log = logging.getLogger(__name__)

Coord = tuple[float, float]  # (lat, lon)

OSRM_URL: str = os.getenv("OSRM_URL", "http://127.0.0.1:5000")
_TIMEOUT = 5  # seconds per HTTP call


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


def _haversine_fallback(
    home: Coord, dest: Coord, stations: list[Coord],
) -> tuple[float, list[float], list[float]]:
    direct = haversine_km(*home, *dest)
    home_dists = [haversine_km(*home, *s) for s in stations]
    station_dists = [haversine_km(*s, *dest) for s in stations]
    return direct, home_dists, station_dists


def _table_get(url_base: str, coord_str: str, sources: str, destinations: str) -> list[list]:
    """One OSRM Table API call; returns distances matrix (metres, None for unreachable)."""
    url = (
        f"{url_base}/table/v1/driving/{coord_str}"
        f"?sources={sources}&destinations={destinations}&annotations=distance"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "gaswatch/1.0"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
        body = json.loads(r.read().decode())
    if body.get("code") != "Ok":
        raise RuntimeError(f"OSRM error code: {body.get('code')}")
    return body["distances"]


def road_matrix_km(
    home: Coord,
    dest: Coord,
    stations: list[Coord],
    osrm_url: str | None = None,
) -> tuple[float, list[float], list[float]]:
    """Return road distances as (direct_km, home_to_station_km[], station_to_dest_km[]).

    Coordinate convention: (lat, lon).

    Uses two OSRM Table API calls with coordinate list [home(0), dest(1), s0(2)..sN(N+1)]:
      Call 1: source=0, destinations=all  -> home->dest + home->each station
      Call 2: sources=2..N+1, dest=1     -> each station->dest

    OSRM returns None for unreachable pairs (e.g. Victoria island stations from mainland).
    Each None falls back to haversine for that individual leg.
    Falls back entirely to haversine on any network or OSRM error.
    """
    if not stations:
        return haversine_km(*home, *dest), [], []

    url_base = (osrm_url or OSRM_URL).rstrip("/")
    n = len(stations)
    # OSRM expects lon,lat ordering
    all_coords = [home, dest] + list(stations)
    coord_str = ";".join(f"{lon},{lat}" for lat, lon in all_coords)

    def safe(v: float | None, fallback: float) -> float:
        return v / 1000.0 if v is not None else fallback

    try:
        # Call 1: home(0) -> [dest(1), s0(2), ..., sN(N+1)]
        dests_all = ",".join(str(i) for i in range(len(all_coords)))
        m1 = _table_get(url_base, coord_str, "0", dests_all)[0]
        direct_km = safe(m1[1], haversine_km(*home, *dest))
        home_dists = [
            safe(m1[k + 2], haversine_km(*home, *stations[k])) for k in range(n)
        ]

        # Call 2: [s0(2)..sN(N+1)] -> dest(1)
        srcs = ",".join(str(k + 2) for k in range(n))
        m2 = _table_get(url_base, coord_str, srcs, "1")
        station_dists = [
            safe(m2[k][0], haversine_km(*stations[k], *dest)) for k in range(n)
        ]

        return direct_km, home_dists, station_dists

    except Exception as exc:  # noqa: BLE001
        _log.warning("OSRM unavailable (%s); falling back to haversine", exc)
        return _haversine_fallback(home, dest, stations)


def route_geometry(
    home: Coord,
    station: Coord,
    dest: Coord,
    osrm_url: str | None = None,
) -> list[list[float]]:
    """Return GeoJSON coordinates [[lon,lat],...] for home→station→dest road route.

    Falls back to three straight-line waypoints if OSRM is unavailable.
    """
    url_base = (osrm_url or OSRM_URL).rstrip("/")
    waypoints = f"{home[1]},{home[0]};{station[1]},{station[0]};{dest[1]},{dest[0]}"
    url = f"{url_base}/route/v1/driving/{waypoints}?overview=full&geometries=geojson"
    req = urllib.request.Request(url, headers={"User-Agent": "gaswatch/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            body = json.loads(r.read().decode())
        if body.get("code") == "Ok":
            return body["routes"][0]["geometry"]["coordinates"]
    except Exception as exc:  # noqa: BLE001
        _log.warning("OSRM route unavailable (%s); returning straight-line waypoints", exc)
    return [
        [home[1], home[0]],
        [station[1], station[0]],
        [dest[1], dest[0]],
    ]
