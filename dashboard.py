#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import contextlib
import datetime
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from gaswatch.config import DB_PATH, DEFAULT_HOST, DEFAULT_PORT, FUEL_PRODUCTS, ROOT_DIR
from gaswatch.db import connect, init_db, get_user_role
from gaswatch.routing import haversine_km, road_matrix_km, route_geometry


STATIC_DIR = ROOT_DIR / "static"
CARS_PATH  = ROOT_DIR / "cars.json"
USER_CARS_DIR = ROOT_DIR / "data" / "users"
DEFAULT_LOYALTY_PATH = ROOT_DIR / "loyalty.json"
RUNTIME_LOYALTY_PATH = ROOT_DIR / "data" / "loyalty.json"
MAX_BODY   = 65_536
OSRM_URL   = os.getenv("OSRM_URL", "http://127.0.0.1:5000")

AUTH_SESSION_COOKIE = "gaswatch_session"
AUTH_STATE_COOKIE = "gaswatch_oauth_state"
AUTH_SESSION_TTL = 7 * 24 * 60 * 60
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
DEFAULT_GOOGLE_REDIRECT_URI = "https://gas.keifu.ca/auth/google/callback"

LOYALTY_ID_RE = re.compile(r"^[a-z0-9_]+$")


def _loyalty_discount(
    brand: str, active_programs: list[str], programs: dict[str, dict] | None = None
) -> float:
    if not active_programs:
        return 0.0
    if programs is None:
        programs = {prog["id"]: prog for prog in load_loyalty_programs()}
    brand_lower = (brand or "").lower()
    today = datetime.date.today().weekday()  # 0=Mon … 6=Sun
    best_discount = 0.0
    for prog_id in active_programs:
        prog = programs.get(prog_id, {})
        if any(pat in brand_lower for pat in prog.get("brands", [])):
            weekdays = prog.get("weekdays")
            if weekdays and today not in weekdays:
                continue
            best_discount = max(best_discount, prog.get("discount_cpl", 0.0))
    return best_discount


def rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def _read_json_body(handler: SimpleHTTPRequestHandler) -> object:
    length = int(handler.headers.get("Content-Length", 0))
    return json.loads(handler.rfile.read(min(length, MAX_BODY)))


def _env_list(name: str) -> list[str]:
    return [item.strip().lower() for item in os.getenv(name, "").split(",") if item.strip()]


def google_client_id() -> str:
    return os.getenv("GASWATCH_GOOGLE_CLIENT_ID", "").strip()


def google_client_secret() -> str:
    return os.getenv("GASWATCH_GOOGLE_CLIENT_SECRET", "").strip()


def google_redirect_uri() -> str:
    return os.getenv("GASWATCH_GOOGLE_REDIRECT_URI", DEFAULT_GOOGLE_REDIRECT_URI).strip()


def auth_enabled() -> bool:
    return bool(google_client_id() and google_client_secret())


def _auth_secret() -> bytes:
    return os.getenv("GASWATCH_AUTH_SECRET", google_client_secret()).encode("utf-8")


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _sign(value: str) -> str:
    return _b64encode(hmac.new(_auth_secret(), value.encode("utf-8"), hashlib.sha256).digest())


def _signed_json(data: dict) -> str:
    payload = _b64encode(json.dumps(data, separators=(",", ":")).encode("utf-8"))
    return f"{payload}.{_sign(payload)}"


def _verify_signed_json(token: str) -> dict | None:
    try:
        payload, sig = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(_sign(payload), sig):
        return None
    try:
        return json.loads(_b64decode(payload).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None


def _cookie_value(header: str | None, name: str) -> str | None:
    if not header:
        return None
    jar = cookies.SimpleCookie()
    try:
        jar.load(header)
    except cookies.CookieError:
        return None
    morsel = jar.get(name)
    return morsel.value if morsel else None


def _cookie_secure() -> bool:
    return os.getenv("GASWATCH_AUTH_COOKIE_SECURE", "1").lower() not in {"0", "false", "no"}


def _cookie_header(name: str, value: str, max_age: int) -> str:
    parts = [f"{name}={value}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
    if _cookie_secure():
        parts.append("Secure")
    return "; ".join(parts)


def _clear_cookie_header(name: str) -> str:
    parts = [f"{name}=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
    if _cookie_secure():
        parts.append("Secure")
    return "; ".join(parts)


def _safe_next_path(path: str | None) -> str:
    if not path or not path.startswith("/") or path.startswith("//"):
        return "/"
    return path


def make_session_token(email: str, now: int | None = None) -> str:
    issued = int(now if now is not None else time.time())
    return _signed_json({"email": email.lower(), "exp": issued + AUTH_SESSION_TTL})


def verify_session_token(token: str | None, now: int | None = None) -> dict | None:
    if not token:
        return None
    data = _verify_signed_json(token)
    if not data:
        return None
    expires = int(data.get("exp", 0))
    current = int(now if now is not None else time.time())
    if expires < current:
        return None
    email = str(data.get("email", "")).lower()
    if not email:
        return None
    return {"email": email}


def current_user(headers) -> dict | None:
    token = _cookie_value(headers.get("Cookie"), AUTH_SESSION_COOKIE)
    return verify_session_token(token)


def make_oauth_state_token(state: str, next_path: str, now: int | None = None) -> str:
    issued = int(now if now is not None else time.time())
    return _signed_json({"state": state, "next": _safe_next_path(next_path), "exp": issued + 600})


def verify_oauth_state_token(token: str | None, state: str, now: int | None = None) -> str | None:
    data = _verify_signed_json(token or "")
    if not data or data.get("state") != state:
        return None
    current = int(now if now is not None else time.time())
    if int(data.get("exp", 0)) < current:
        return None
    return _safe_next_path(str(data.get("next", "/")))


def google_auth_url(state: str) -> str:
    return GOOGLE_AUTH_URL + "?" + urlencode({
        "client_id": google_client_id(),
        "redirect_uri": google_redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    })


def _post_form(url: str, data: dict) -> dict:
    body = urlencode(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(url: str, bearer_token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {bearer_token}"})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def exchange_google_code(code: str) -> dict:
    token_data = _post_form(GOOGLE_TOKEN_URL, {
        "code": code,
        "client_id": google_client_id(),
        "client_secret": google_client_secret(),
        "redirect_uri": google_redirect_uri(),
        "grant_type": "authorization_code",
    })
    access_token = token_data.get("access_token")
    if not access_token:
        raise ValueError("Google did not return an access token")
    return _get_json(GOOGLE_USERINFO_URL, access_token)


def google_user_allowed(userinfo: dict) -> bool:
    email = str(userinfo.get("email", "")).lower()
    if not email or userinfo.get("email_verified") not in (True, "true", "True", 1):
        return False
    allowed_emails = _env_list("GASWATCH_ALLOWED_EMAILS")
    if allowed_emails:
        return email in allowed_emails
    allowed_domains = _env_list("GASWATCH_ALLOWED_DOMAINS")
    if allowed_domains:
        domain = email.rsplit("@", 1)[-1]
        return domain in allowed_domains
    return True


class DashboardHandler(SimpleHTTPRequestHandler):
    db_path = DB_PATH

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def send_json(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def redirect(self, location: str, *, cookies_to_set: list[str] | None = None) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        for cookie in cookies_to_set or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def auth_required_response(self, parsed) -> None:
        if parsed.path.startswith("/api/"):
            return self.send_json({"error": "authentication required"}, status=401)
        next_path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        return self.redirect("/auth/login?" + urlencode({"next": next_path}))

    def ensure_authenticated(self, parsed) -> bool:
        if not auth_enabled():
            return True
        if current_user(self.headers):
            return True
        self.auth_required_response(parsed)
        return False

    def is_admin(self) -> bool:
        if not auth_enabled():
            return True
        user = current_user(self.headers)
        if not user:
            return False
        with contextlib.closing(connect(self.db_path)) as conn:
            return get_user_role(conn, user["email"]) == "admin"

    def handle_auth_get(self, parsed) -> bool:
        if parsed.path == "/auth/login":
            if not auth_enabled():
                return self.redirect("/")
            qs = parse_qs(parsed.query)
            next_path = _safe_next_path((qs.get("next") or ["/"])[0])
            state = secrets.token_urlsafe(24)
            state_cookie = _cookie_header(AUTH_STATE_COOKIE, make_oauth_state_token(state, next_path), 600)
            return self.redirect(google_auth_url(state), cookies_to_set=[state_cookie])
        if parsed.path == "/auth/logout":
            return self.redirect("/auth/login", cookies_to_set=[_clear_cookie_header(AUTH_SESSION_COOKIE)])
        if parsed.path == "/auth/google/callback":
            if not auth_enabled():
                return self.redirect("/")
            qs = parse_qs(parsed.query)
            if qs.get("error"):
                return self.send_json({"error": qs["error"][0]}, status=400)
            code = (qs.get("code") or [""])[0]
            state = (qs.get("state") or [""])[0]
            state_cookie = _cookie_value(self.headers.get("Cookie"), AUTH_STATE_COOKIE)
            next_path = verify_oauth_state_token(state_cookie, state)
            if not code or not next_path:
                return self.send_json({"error": "invalid oauth state"}, status=400)
            try:
                userinfo = exchange_google_code(code)
            except (ValueError, urllib.error.URLError, json.JSONDecodeError):
                logging.exception("google oauth exchange failed")
                return self.send_json({"error": "google authentication failed"}, status=502)
            if not google_user_allowed(userinfo):
                return self.send_json({"error": "google account not allowed"}, status=403)
            email = str(userinfo["email"]).lower()
            return self.redirect(
                next_path,
                cookies_to_set=[
                    _cookie_header(AUTH_SESSION_COOKIE, make_session_token(email), AUTH_SESSION_TTL),
                    _clear_cookie_header(AUTH_STATE_COOKIE),
                ],
            )
        return False

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not self.ensure_authenticated(parsed):
            return
        if parsed.path not in {"/api/cars", "/api/loyalty-programs"}:
            return self.send_json({"error": "not found"}, status=404)
        if parsed.path == "/api/loyalty-programs" and not self.is_admin():
            return self.send_json({"error": "administrator role required"}, status=403)
        try:
            body = _read_json_body(self)
            if parsed.path == "/api/cars":
                user = current_user(self.headers)
                if user:
                    save_user_cars(user["email"], body)
                else:
                    save_cars(body)
            else:
                save_loyalty_programs(body)
            return self.send_json({"ok": True})
        except (ValueError, KeyError) as exc:
            return self.send_json({"error": str(exc)}, status=400)
        except Exception:
            logging.exception("cars save error")
            return self.send_json({"error": "internal error"}, status=500)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if self.handle_auth_get(parsed):
            return
        if not self.ensure_authenticated(parsed):
            return
        if parsed.path == "/":
            self.path = "/index.html"
            return super().do_GET()
        if not parsed.path.startswith("/api/"):
            return super().do_GET()

        try:
            with contextlib.closing(connect(self.db_path)) as conn:
                if parsed.path == "/api/user":
                    user = current_user(self.headers)
                    if not user:
                        return self.send_json({"error": "not authenticated"}, status=401)
                    return self.send_json({
                        "email": user["email"],
                        "role": get_user_role(conn, user["email"]),
                    })
                if parsed.path == "/api/summary":
                    return self.send_json(summary(conn))
                if parsed.path == "/api/health":
                    return self.send_json(health(conn))
                if parsed.path == "/api/trends":
                    qs = parse_qs(parsed.query)
                    hours = clamp_int((qs.get("hours") or ["168"])[0], default=168, low=1, high=8760)
                    fuel = (qs.get("fuel") or ["regular_gas"])[0]
                    if fuel not in FUEL_PRODUCTS:
                        return self.send_json({"error": "invalid fuel"}, status=400)
                    return self.send_json(trends(conn, hours, fuel))
                if parsed.path == "/api/latest":
                    qs = parse_qs(parsed.query)
                    city = (qs.get("city") or [""])[0]
                    if city and not city_exists(conn, city):
                        return self.send_json({"error": "invalid city"}, status=400)
                    fuel = (qs.get("fuel") or [""])[0]
                    if fuel and fuel not in FUEL_PRODUCTS:
                        return self.send_json({"error": "invalid fuel"}, status=400)
                    return self.send_json(latest_prices(conn, city or None, fuel or None))
                if parsed.path == "/api/cars":
                    user = current_user(self.headers)
                    cfg = load_user_cars(user["email"]) if user else load_cars()
                    cfg["available_loyalty_programs"] = [
                        {"id": p["id"], "name": p["name"], "description": p.get("description", "")}
                        for p in load_loyalty_programs()
                    ]
                    return self.send_json(cfg)
                if parsed.path == "/api/loyalty-programs":
                    if not self.is_admin():
                        return self.send_json({"error": "administrator role required"}, status=403)
                    return self.send_json({"programs": load_loyalty_programs()})
                if parsed.path == "/api/trip":
                    qs = parse_qs(parsed.query)
                    try:
                        dest_lat    = float((qs.get("dest_lat")    or [""])[0])
                        dest_lng    = float((qs.get("dest_lng")    or [""])[0])
                        l_per_100km = float((qs.get("l_per_100km") or [""])[0])
                        fill_litres = float((qs.get("fill_litres") or [""])[0])
                        remaining_raw = (qs.get("remaining_km") or [None])[0]
                        remaining_km = float(remaining_raw) if remaining_raw not in (None, "") else None
                        trip_user = current_user(self.headers)
                        cars_cfg = load_user_cars(trip_user["email"]) if trip_user else load_cars()
                        home_lat = float((qs.get("home_lat") or [str(cars_cfg["home"]["lat"])])[0])
                        home_lng = float((qs.get("home_lng") or [str(cars_cfg["home"]["lng"])])[0])
                    except ValueError:
                        return self.send_json({"error": "dest_lat, dest_lng, l_per_100km, fill_litres required"}, status=400)
                    if l_per_100km <= 0 or fill_litres <= 0:
                        return self.send_json({"error": "l_per_100km and fill_litres must be greater than 0"}, status=400)
                    fuel = (qs.get("fuel") or ["regular_gas"])[0]
                    if fuel not in FUEL_PRODUCTS:
                        return self.send_json({"error": "invalid fuel"}, status=400)
                    max_age  = clamp_int((qs.get("max_age") or ["4"])[0], default=4, low=1, high=48)
                    loyalty  = parse_loyalty_param(qs, cars_cfg.get("loyalty_programs", []))
                    return self.send_json(trip_prices(conn, home_lat, home_lng, dest_lat, dest_lng, fuel, l_per_100km, fill_litres, max_age, loyalty, remaining_km))
                if parsed.path == "/api/route":
                    qs = parse_qs(parsed.query)
                    try:
                        home_lat    = float((qs.get("home_lat")    or [""])[0])
                        home_lng    = float((qs.get("home_lng")    or [""])[0])
                        station_lat = float((qs.get("station_lat") or [""])[0])
                        station_lng = float((qs.get("station_lng") or [""])[0])
                        dest_lat    = float((qs.get("dest_lat")    or [""])[0])
                        dest_lng    = float((qs.get("dest_lng")    or [""])[0])
                    except ValueError:
                        return self.send_json({"error": "home_lat/lng, station_lat/lng, dest_lat/lng required"}, status=400)
                    coords = route_geometry(
                        (home_lat, home_lng),
                        (station_lat, station_lng),
                        (dest_lat, dest_lng),
                        osrm_url=OSRM_URL,
                    )
                    return self.send_json({"coordinates": coords})
                if parsed.path == "/api/nearby":
                    qs = parse_qs(parsed.query)
                    try:
                        lat = float((qs.get("lat") or [""])[0])
                        lng = float((qs.get("lng") or [""])[0])
                    except ValueError:
                        return self.send_json({"error": "lat and lng required"}, status=400)
                    fuel = (qs.get("fuel") or ["regular_gas"])[0]
                    if fuel not in FUEL_PRODUCTS:
                        return self.send_json({"error": "invalid fuel"}, status=400)
                    radius_km = clamp_int((qs.get("radius") or ["15"])[0], default=15, low=1, high=100)
                    max_age   = clamp_int((qs.get("max_age") or ["4"])[0], default=4, low=1, high=48)
                    nearby_user = current_user(self.headers)
                    cars_cfg = load_user_cars(nearby_user["email"]) if nearby_user else load_cars()
                    loyalty   = parse_loyalty_param(qs, cars_cfg.get("loyalty_programs", []))
                    try:
                        l_per_100km_raw = (qs.get("l_per_100km") or [None])[0]
                        fill_litres_raw = (qs.get("fill_litres") or [None])[0]
                        remaining_raw = (qs.get("remaining_km") or [None])[0]
                        l_per_100km = float(l_per_100km_raw) if l_per_100km_raw not in (None, "") else None
                        fill_litres = float(fill_litres_raw) if fill_litres_raw not in (None, "") else None
                        remaining_km = float(remaining_raw) if remaining_raw not in (None, "") else None
                    except ValueError:
                        return self.send_json({"error": "l_per_100km, fill_litres, and remaining_km must be numbers"}, status=400)
                    return self.send_json(nearby_prices(conn, lat, lng, fuel, radius_km, max_age, loyalty, l_per_100km, fill_litres, remaining_km))
                if parsed.path == "/api/runs":
                    return self.send_json(runs(conn))
                if parsed.path == "/api/station-trends":
                    qs = parse_qs(parsed.query)
                    hours = clamp_int((qs.get("hours") or ["168"])[0], default=168, low=1, high=8760)
                    fuel = (qs.get("fuel") or ["regular_gas"])[0]
                    if fuel not in FUEL_PRODUCTS:
                        return self.send_json({"error": "invalid fuel"}, status=400)
                    raw_cities = (qs.get("city") or [""])[0]
                    city_slugs = [s.strip() for s in raw_cities.split(",") if s.strip()]
                    if not city_slugs:
                        return self.send_json({"error": "city required"}, status=400)
                    invalid = [s for s in city_slugs if not city_exists(conn, s)]
                    if invalid:
                        return self.send_json({"error": f"invalid city: {invalid[0]}"}, status=400)
                    station_id = (qs.get("station_id") or [""])[0]
                    return self.send_json(station_trends(conn, city_slugs, hours, fuel, station_id or None))
        except Exception as exc:
            logging.exception("dashboard error")
            return self.send_json({"error": "internal error"}, status=500)
        self.send_json({"error": "not found"}, status=404)

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if self.handle_auth_get(parsed):
            return
        if not self.ensure_authenticated(parsed):
            return
        if parsed.path == "/":
            self.path = "/index.html"
        return super().do_HEAD()


def summary(conn: sqlite3.Connection) -> dict:
    last_scan = conn.execute("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").fetchone()
    return {
        "last_scan": dict(last_scan) if last_scan else None,
        "cities": rows(
            conn,
            """
            SELECT
                c.slug, c.name,
                COUNT(DISTINCT sc.station_id) AS station_count,
                MAX(s.last_seen_at) AS last_seen_at,
                (
                    SELECT ROUND(AVG(po.price), 3)
                    FROM price_observations po
                    WHERE po.city_slug = c.slug
                      AND po.fuel_product = 'regular_gas'
                      AND po.payment_type = 'credit'
                      AND po.observed_at = (
                        SELECT MAX(observed_at)
                        FROM price_observations
                        WHERE city_slug = c.slug AND fuel_product = 'regular_gas'
                          AND payment_type = 'credit'
                      )
                ) AS latest_regular_avg
            FROM cities c
            LEFT JOIN station_cities sc ON sc.city_slug = c.slug
            LEFT JOIN stations s ON s.id = sc.station_id
            GROUP BY c.slug, c.name
            ORDER BY c.name
            """,
        ),
    }


def health(conn: sqlite3.Connection) -> dict:
    last_scan = conn.execute("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").fetchone()
    return {
        "ok": True,
        "last_scan": dict(last_scan) if last_scan else None,
    }


def clamp_int(value: str, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(low, min(high, parsed))


def parse_loyalty_param(qs: dict[str, list[str]], fallback: list[str] | None = None) -> list[str]:
    raw = (qs.get("loyalty") or [None])[0]
    if raw is None:
        return fallback or []
    known = _loyalty_program_ids()
    return [item for item in (part.strip() for part in raw.split(",")) if item in known]


def city_exists(conn: sqlite3.Connection, slug: str) -> bool:
    return conn.execute("SELECT 1 FROM cities WHERE slug = ?", (slug,)).fetchone() is not None


def trends(conn: sqlite3.Connection, hours: int, fuel: str) -> dict:
    return {
        "fuel": fuel,
        "hours": hours,
        "points": rows(
            conn,
            """
            SELECT c.name AS city, cs.city_slug, cs.observed_at, cs.station_count,
                   ROUND(cs.min_price, 3) AS min_price,
                   ROUND(cs.avg_price, 3) AS avg_price,
                   ROUND(cs.max_price, 3) AS max_price
            FROM city_snapshots cs
            JOIN cities c ON c.slug = cs.city_slug
            WHERE cs.fuel_product = ?
              AND julianday(cs.observed_at) >= julianday('now', ?)
            ORDER BY cs.observed_at, c.name
            """,
            (fuel, f"-{hours} hours"),
        ),
    }


def station_trends(
    conn: sqlite3.Connection,
    city_slugs: list[str],
    hours: int,
    fuel: str,
    station_id: str | None = None,
) -> dict:
    city_filter = ""
    params = [fuel, f"-{hours} hours"]
    if station_id:
        params.append(station_id)
    else:
        placeholders = ",".join("?" * len(city_slugs))
        city_filter = f"AND po.city_slug IN ({placeholders})"
        params.extend(city_slugs)
    return {
        "fuel": fuel,
        "hours": hours,
        "station_id": station_id,
        "points": rows(
            conn,
            f"""
            SELECT po.station_id,
                   s.name || CASE WHEN s.address_line1 IS NOT NULL
                               THEN ' · ' || TRIM(s.address_line1)
                               ELSE '' END AS station,
                   c.name AS city,
                   po.observed_at,
                   ROUND(MIN(po.price), 1) AS price
            FROM price_observations po
            JOIN stations s ON s.id = po.station_id
            JOIN cities c ON c.slug = po.city_slug
            WHERE po.fuel_product = ?
              AND po.payment_type = 'credit'
              AND julianday(po.observed_at) >= julianday('now', ?)
              {"AND po.station_id = ?" if station_id else city_filter}
            GROUP BY po.station_id, station, c.name, po.observed_at
            ORDER BY po.observed_at, po.station_id
            """,
            tuple(params),
        ),
    }


def latest_prices(conn: sqlite3.Connection, city: str | None, fuel: str | None = None) -> dict:
    params: list[str] = []
    city_filter = ""
    if city:
        city_filter = "AND po.city_slug = ?"
        params.append(city)
    fuel_filter = ""
    if fuel:
        fuel_filter = "AND po.fuel_product = ?"
        params.append(fuel)
    return {
        "stations": rows(
            conn,
            f"""
            WITH latest AS (
                SELECT city_slug, station_id, fuel_product, MAX(observed_at) AS observed_at
                FROM price_observations po
                WHERE 1 = 1 {city_filter} {fuel_filter}
                  AND po.payment_type = 'credit'
                GROUP BY city_slug, station_id, fuel_product
            )
            SELECT c.name AS city, s.id AS station_id, s.name, COALESCE(s.brand, s.name) AS brand,
                   s.address_line1, s.latitude, s.longitude, po.fuel_product, po.payment_type, po.price,
                   po.posted_at, po.observed_at
            FROM latest l
            JOIN price_observations po ON po.city_slug = l.city_slug
                AND po.station_id = l.station_id
                AND po.fuel_product = l.fuel_product
                AND po.observed_at = l.observed_at
                AND po.payment_type = 'credit'
            JOIN stations s ON s.id = po.station_id
            JOIN cities c ON c.slug = po.city_slug
            ORDER BY po.price ASC, c.name, s.name
            LIMIT 1000
            """,
            tuple(params),
        )
    }


def runs(conn: sqlite3.Connection) -> dict:
    return {
        "runs": rows(conn, "SELECT * FROM scan_runs ORDER BY id DESC LIMIT 4"),
        "city_runs": rows(conn, "SELECT * FROM city_runs ORDER BY id DESC LIMIT 56"),
    }


_CARS_DEFAULT = {
    "home": {"lat": 0.0, "lng": 0.0, "label": "Home"},
    "fuel": "regular_gas",
    "cars": [],
    "loyalty_programs": [],
}


def _user_cars_path(email: str) -> Path:
    key = hashlib.sha256(email.lower().encode()).hexdigest()[:32]
    return USER_CARS_DIR / f"{key}.json"


def load_cars() -> dict:
    if not CARS_PATH.exists():
        return _CARS_DEFAULT.copy()
    try:
        return json.loads(CARS_PATH.read_text())
    except json.JSONDecodeError:
        return _CARS_DEFAULT.copy()


def load_user_cars(email: str) -> dict:
    path = _user_cars_path(email)
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            pass
    return load_cars()


def _loyalty_program_ids() -> set[str]:
    return {program["id"] for program in load_loyalty_programs()}


def validate_loyalty_programs(data: object) -> list[dict]:
    raw_programs = data.get("programs") if isinstance(data, dict) else data
    if not isinstance(raw_programs, list):
        raise ValueError("programs must be a list")
    seen: set[str] = set()
    programs = []
    for idx, raw in enumerate(raw_programs, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"program {idx} must be an object")
        prog_id = str(raw.get("id", "")).strip()
        if not prog_id or not LOYALTY_ID_RE.fullmatch(prog_id):
            raise ValueError(f"program {idx} id must use lowercase letters, numbers, and underscores")
        if prog_id in seen:
            raise ValueError(f"duplicate loyalty program id: {prog_id}")
        seen.add(prog_id)
        name = str(raw.get("name", "")).strip()
        if not name:
            raise ValueError(f"program {prog_id} name required")
        try:
            discount_cpl = float(raw.get("discount_cpl", 0))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"program {prog_id} discount_cpl must be numeric") from exc
        if discount_cpl < 0:
            raise ValueError(f"program {prog_id} discount_cpl must be non-negative")
        raw_brands = raw.get("brands", [])
        if isinstance(raw_brands, str):
            raw_brands = [item.strip() for item in raw_brands.split(",")]
        brands = [str(item).strip().lower() for item in raw_brands if str(item).strip()] if isinstance(raw_brands, list) else []
        if not brands:
            raise ValueError(f"program {prog_id} brands required")
        program = {
            "id": prog_id,
            "name": name,
            "description": str(raw.get("description", "")).strip(),
            "discount_cpl": discount_cpl,
            "brands": brands,
        }
        raw_weekdays = raw.get("weekdays")
        if isinstance(raw_weekdays, str):
            raw_weekdays = [item.strip() for item in raw_weekdays.split(",") if item.strip()]
        if raw_weekdays:
            if not isinstance(raw_weekdays, list):
                raise ValueError(f"program {prog_id} weekdays must be a list")
            weekdays = []
            for item in raw_weekdays:
                try:
                    weekday = int(item)
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"program {prog_id} weekdays must be integers 0-6") from exc
                if weekday < 0 or weekday > 6:
                    raise ValueError(f"program {prog_id} weekdays must be integers 0-6")
                if weekday not in weekdays:
                    weekdays.append(weekday)
            program["weekdays"] = weekdays
        programs.append(program)
    return programs


def load_loyalty_programs() -> list[dict]:
    path = RUNTIME_LOYALTY_PATH if RUNTIME_LOYALTY_PATH.exists() else DEFAULT_LOYALTY_PATH
    return validate_loyalty_programs(json.loads(path.read_text()))


def save_loyalty_programs(data: object) -> None:
    programs = validate_loyalty_programs(data)
    RUNTIME_LOYALTY_PATH.parent.mkdir(parents=True, exist_ok=True)
    RUNTIME_LOYALTY_PATH.write_text(json.dumps({"programs": programs}, indent=2) + "\n")


def _clean_cars_cfg(cfg: dict) -> dict:
    home = cfg["home"]
    home_lat = float(home["lat"])
    home_lng = float(home["lng"])
    cars = []
    for car in cfg.get("cars", []):
        if not car.get("name"):
            raise ValueError("car name required")
        if car.get("l_per_100km") is None:
            raise ValueError(f"efficiency (L/100km) required for {car['name']}")
        if car.get("tank_litres") is None:
            raise ValueError(f"tank size required for {car['name']}")
        cars.append({
            "name": str(car["name"]),
            "l_per_100km": float(car["l_per_100km"]),
            "tank_litres": float(car["tank_litres"]),
        })
    fuel = cfg.get("fuel")
    if fuel not in FUEL_PRODUCTS:
        raise ValueError("invalid fuel")
    known_loyalty_ids = _loyalty_program_ids()
    loyalty_programs = [
        p for p in cfg.get("loyalty_programs", []) if p in known_loyalty_ids
    ]
    return {
        "home": {"lat": home_lat, "lng": home_lng, "label": str(home.get("label", "Home"))},
        "fuel": fuel,
        "include_victoria": bool(cfg.get("include_victoria", True)),
        "cars": cars,
        "loyalty_programs": loyalty_programs,
    }


def save_cars(cfg: dict) -> None:
    CARS_PATH.write_text(json.dumps(_clean_cars_cfg(cfg), indent=2))


def save_user_cars(email: str, cfg: dict) -> None:
    clean = _clean_cars_cfg(cfg)
    USER_CARS_DIR.mkdir(parents=True, exist_ok=True)
    _user_cars_path(email).write_text(json.dumps(clean, indent=2))


_PRICE_SQL = """
    WITH ranked AS (
        SELECT po.*,
               ROW_NUMBER() OVER (
                   PARTITION BY po.station_id, po.fuel_product
                   ORDER BY po.observed_at DESC, po.price ASC, po.id DESC
               ) AS row_num
        FROM price_observations po
        WHERE po.fuel_product = ? AND po.payment_type = 'credit'
          AND julianday(po.observed_at) >= julianday('now', ?)
    )
    SELECT s.id AS station_id, s.name, COALESCE(s.brand, s.name) AS brand,
           s.address_line1, s.locality, s.latitude, s.longitude,
           po.price, po.posted_at, po.observed_at
    FROM ranked po
    JOIN stations s ON s.id = po.station_id
    WHERE po.row_num = 1
      AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
"""


def trip_prices(
    conn: sqlite3.Connection,
    home_lat: float, home_lng: float,
    dest_lat: float, dest_lng: float,
    fuel: str, l_per_100km: float, fill_litres: float,
    max_age_hours: int = 4,
    loyalty_programs: list[str] | None = None,
    remaining_km: float | None = None,
) -> dict:
    if fill_litres <= 0:
        raise ValueError("fill_litres must be greater than 0")
    if l_per_100km <= 0:
        raise ValueError("l_per_100km must be greater than 0")
    active_loyalty = loyalty_programs or []
    loyalty_lookup = {p["id"]: p for p in load_loyalty_programs()} if active_loyalty else {}
    station_rows = rows(conn, _PRICE_SQL, (fuel, f"-{max_age_hours} hours"))

    home_coord = (home_lat, home_lng)
    dest_coord = (dest_lat, dest_lng)
    station_coords = [(row["latitude"], row["longitude"]) for row in station_rows]

    direct_km, home_dists, station_dists = road_matrix_km(
        home_coord, dest_coord, station_coords, osrm_url=OSRM_URL
    )

    results = []
    for i, row in enumerate(station_rows):
        home_to_station = home_dists[i]
        via_km = home_to_station + station_dists[i]
        detour_km = max(0.0, via_km - direct_km)
        extra_litres = detour_km * (l_per_100km / 100.0)
        discount = _loyalty_discount(row["brand"], active_loyalty, loyalty_lookup)
        price_per_litre = (row["price"] - discount) / 100.0
        total_cost = (fill_litres + extra_litres) * price_per_litre
        effective_cpl = (total_cost / fill_litres) * 100.0
        row["home_to_station_km"] = round(home_to_station, 2)
        row["detour_km"] = round(detour_km, 2)
        row["effective_cpl"] = round(effective_cpl, 1)
        row["loyalty_discount_cpl"] = discount
        row["total_cost"] = round(total_cost, 2)
        row["out_of_range"] = remaining_km is not None and home_to_station > remaining_km
        results.append(row)
    results.sort(key=lambda r: (r["out_of_range"], r["effective_cpl"]))
    return {
        "stations": results[:30],
        "home": {"lat": home_lat, "lng": home_lng},
        "dest": {"lat": dest_lat, "lng": dest_lng},
        "direct_km": round(direct_km, 1),
        "fuel": fuel,
        "max_age_hours": max_age_hours,
        "station_count": len(results),
    }


def nearby_prices(
    conn: sqlite3.Connection,
    lat: float,
    lng: float,
    fuel: str,
    radius_km: int = 15,
    max_age_hours: int = 4,
    loyalty_programs: list[str] | None = None,
    l_per_100km: float | None = None,
    fill_litres: float | None = None,
    remaining_km: float | None = None,
) -> dict:
    active_loyalty = loyalty_programs or []
    loyalty_lookup = {p["id"]: p for p in load_loyalty_programs()} if active_loyalty else {}
    use_trip_cost = l_per_100km is not None and fill_litres is not None and l_per_100km > 0 and fill_litres > 0
    station_rows = rows(conn, _PRICE_SQL, (fuel, f"-{max_age_hours} hours"))
    results = []
    for row in station_rows:
        dist = haversine_km(lat, lng, row["latitude"], row["longitude"])
        if dist <= radius_km:
            discount = _loyalty_discount(row["brand"], active_loyalty, loyalty_lookup)
            effective_price = row["price"] - discount
            row["distance_km"] = round(dist, 2)
            row["loyalty_discount_cpl"] = discount
            row["out_of_range"] = remaining_km is not None and dist > remaining_km
            if use_trip_cost:
                # Round trip: you drive to the station and back
                extra_litres = 2.0 * dist * (l_per_100km / 100.0)
                total_cost = (fill_litres + extra_litres) * (effective_price / 100.0)
                row["total_cost"] = round(total_cost, 2)
                row["effective_cpl"] = round((total_cost / fill_litres) * 100.0, 1)
            else:
                row["total_cost"] = None
                row["effective_cpl"] = round(effective_price, 1)
            results.append(row)
    results.sort(key=lambda r: (r["out_of_range"], r["effective_cpl"], r["distance_km"]))
    return {"stations": results[:50], "lat": lat, "lng": lng, "radius_km": radius_km, "max_age_hours": max_age_hours}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the gas trend dashboard.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--db", default=str(DB_PATH))
    parser.add_argument("--certfile", default=os.getenv("GASWATCH_CERTFILE"))
    parser.add_argument("--keyfile", default=os.getenv("GASWATCH_KEYFILE"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    DashboardHandler.db_path = Path(args.db)
    with connect(DashboardHandler.db_path) as conn:
        init_db(conn)
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    if args.certfile and args.keyfile:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.certfile, args.keyfile)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        print(f"Dashboard: https://{args.host}:{args.port}/")
    else:
        print(f"Dashboard: http://{args.host}:{args.port}/")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
