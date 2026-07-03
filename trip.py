#!/usr/bin/env python3
"""Find the most cost-effective gas station for your trip."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from dashboard import load_loyalty_programs, trip_prices
from gaswatch.config import DB_PATH
from gaswatch.db import connect
from gaswatch.routing import haversine_km

CONFIG_PATH = Path(__file__).parent / "cars.json"
MAX_AGE_HOURS = 4  # same freshness window as the dashboard default

FUEL_LABELS = {
    "regular_gas": "Regular",
    "midgrade_gas": "Midgrade",
    "premium_gas": "Premium",
    "diesel": "Diesel",
}
FUEL_KEYS = list(FUEL_LABELS.keys())


# ── Utilities ────────────────────────────────────────────────────────────────

def geocode(address: str) -> tuple[float, float, str]:
    q = urllib.parse.urlencode({"q": address, "format": "json", "limit": "1", "countrycodes": "ca"})
    req = urllib.request.Request(
        f"https://nominatim.openstreetmap.org/search?{q}",
        headers={"User-Agent": "gaswatch-trip/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
    except urllib.error.URLError as exc:
        raise SystemExit(f"Geocoding failed: {exc.reason}") from exc
    if not data:
        raise SystemExit(f"No results found for: {address!r}")
    return float(data[0]["lat"]), float(data[0]["lon"]), data[0].get("display_name", address)


def prompt(text: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    val = input(f"{text}{suffix}: ").strip()
    return val or default


def prompt_float(text: str, default: str = "", minimum: float | None = None) -> float:
    while True:
        raw = prompt(text, default)
        try:
            val = float(raw)
        except ValueError:
            print("  Enter a number.")
            continue
        if minimum is not None and val <= minimum:
            print(f"  Enter a number greater than {minimum:g}.")
            continue
        return val


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    print(f"  Saved to {CONFIG_PATH}")


# ── Config management ────────────────────────────────────────────────────────

def edit_car(car: dict | None = None) -> dict:
    """Prompt for car fields. If car is given, existing values are the defaults."""
    existing = car or {}
    name       = prompt("  Car name", existing.get("name", ""))
    l_per_100km = prompt_float("  Fuel use (L/100km)", str(existing.get("l_per_100km", "")), minimum=0.0)
    tank       = prompt_float("  Tank size (litres)", str(existing.get("tank_litres", "")), minimum=0.0)
    return {
        "name":        name,
        "l_per_100km": l_per_100km,
        "tank_litres": tank,
    }


def manage_cars(cfg: dict) -> None:
    while True:
        cars = cfg["cars"]
        home = cfg["home"]
        fuel = cfg.get("fuel", "regular_gas")

        print("\n── Car & Settings Manager ──────────────────")
        print(f"  Home:  {home['label']}  ({home['lat']}, {home['lng']})")
        print(f"  Fuel:  {FUEL_LABELS.get(fuel, fuel)}")
        print()
        if cars:
            for i, c in enumerate(cars, 1):
                print(f"  {i}. {c['name']}  ({c['l_per_100km']} L/100km, {c['tank_litres']} L tank)")
        else:
            print("  (no cars yet)")
        print()
        print("  a. Add car")
        if cars:
            print("  e. Edit car")
            print("  d. Delete car")
        print("  h. Set home location")
        print("  f. Set default fuel")
        print("  q. Done")

        choice = input("\nChoice: ").strip().lower()

        if choice == "a":
            print("\nNew car:")
            cfg["cars"].append(edit_car())
            save_config(cfg)

        elif choice == "e" and cars:
            print("\nEdit which car?")
            for i, c in enumerate(cars, 1):
                print(f"  {i}. {c['name']}")
            raw = input("Number: ").strip()
            if raw.isdigit() and 1 <= int(raw) <= len(cars):
                idx = int(raw) - 1
                print(f"\nEditing {cars[idx]['name']} (press Enter to keep current value):")
                cfg["cars"][idx] = edit_car(cars[idx])
                save_config(cfg)

        elif choice == "d" and cars:
            print("\nDelete which car?")
            for i, c in enumerate(cars, 1):
                print(f"  {i}. {c['name']}")
            raw = input("Number: ").strip()
            if raw.isdigit() and 1 <= int(raw) <= len(cars):
                removed = cfg["cars"].pop(int(raw) - 1)
                print(f"  Removed {removed['name']}")
                save_config(cfg)

        elif choice == "h":
            addr = input("\nHome address (or press Enter to enter coordinates manually): ").strip()
            if addr:
                print(f'  Geocoding "{addr}"…')
                lat, lng, display = geocode(addr)
                print(f"  → {display}")
                print(f"  {lat:.4f}, {lng:.4f}")
                if input("  Use this? [Y/n]: ").strip().lower() != "n":
                    label = prompt("  Label for home", addr.split(",")[0])
                    cfg["home"] = {"lat": lat, "lng": lng, "label": label}
                    save_config(cfg)
            else:
                lat  = prompt_float("  Latitude")
                lng  = prompt_float("  Longitude")
                label = prompt("  Label", "Home")
                cfg["home"] = {"lat": lat, "lng": lng, "label": label}
                save_config(cfg)

        elif choice == "f":
            print("\nDefault fuel type:")
            for i, (k, v) in enumerate(FUEL_LABELS.items(), 1):
                mark = " ←" if k == fuel else ""
                print(f"  {i}. {v}{mark}")
            raw = input("Number: ").strip()
            if raw.isdigit() and 1 <= int(raw) <= len(FUEL_KEYS):
                cfg["fuel"] = FUEL_KEYS[int(raw) - 1]
                save_config(cfg)

        elif choice == "q":
            break


# ── Main trip flow ───────────────────────────────────────────────────────────

def main() -> None:
    if not CONFIG_PATH.exists():
        print("No cars.json found — let's set it up.\n")
        cfg: dict = {"home": {"lat": 0.0, "lng": 0.0, "label": "Home"}, "fuel": "regular_gas", "cars": []}
        manage_cars(cfg)
        if not cfg["cars"]:
            raise SystemExit("Add at least one car to continue.")

    cfg = json.loads(CONFIG_PATH.read_text())
    home = cfg["home"]
    cars = cfg["cars"]
    fuel = cfg.get("fuel", "regular_gas")

    print("\n=== Trip Gas Calculator ===\n")

    # Car picker (with manage option)
    while True:
        print("Select your car:")
        for i, c in enumerate(cars, 1):
            print(f"  {i}. {c['name']}  ({c['l_per_100km']} L/100km, {c['tank_litres']} L tank)")
        print("  m. Manage cars & settings")
        raw = input("Choice: ").strip().lower()
        if raw == "m":
            manage_cars(cfg)
            cfg = json.loads(CONFIG_PATH.read_text())
            home = cfg["home"]
            cars = cfg["cars"]
            fuel = cfg.get("fuel", "regular_gas")
            print()
            continue
        if raw.isdigit() and 1 <= int(raw) <= len(cars):
            car = cars[int(raw) - 1]
            break
        print(f"  Enter a number 1–{len(cars)} or m")

    l_per_100km: float = car["l_per_100km"]
    loyalty: list[str] = cfg.get("loyalty_programs", [])

    # Fill amount
    fill_litres = prompt_float("Litres to fill", str(car["tank_litres"]), minimum=0.0)

    # Destination (round trip = home→station→home, modelled as a trip back to home)
    addr = input("\nWhere are you going after filling up? (press Enter to return home): ").strip()
    one_way = bool(addr)

    dest_lat, dest_lng = home["lat"], home["lng"]
    dest_label = ""
    if one_way:
        while True:
            print(f'  Geocoding "{addr}"…')
            dest_lat, dest_lng, display_name = geocode(addr)
            dest_label = addr
            direct_km = haversine_km(home["lat"], home["lng"], dest_lat, dest_lng)
            print(f"  → {display_name}")
            print(f"  {dest_lat:.4f}, {dest_lng:.4f}  ({direct_km:.1f} km from home)")
            if input("  Use this location? [Y/n]: ").strip().lower() != "n":
                break
            addr = input("  Enter a more specific address (include city and province): ").strip()
            if not addr:
                raise SystemExit("Aborted.")
        print()

    # Load and score stations
    print("Loading station prices…")
    if not DB_PATH.exists():
        raise SystemExit(f"Database not found: {DB_PATH}\nRun scan.py first.")
    conn = connect(DB_PATH)
    try:
        result = trip_prices(
            conn,
            home["lat"], home["lng"], dest_lat, dest_lng,
            fuel, l_per_100km, fill_litres,
            max_age_hours=MAX_AGE_HOURS,
            loyalty_programs=loyalty,
        )
    finally:
        conn.close()

    fuel_label = FUEL_LABELS.get(fuel, fuel)
    top = result["stations"][:15]
    if not top:
        raise SystemExit(
            f"No {fuel_label} credit prices newer than {MAX_AGE_HOURS}h in DB. Run scan.py first."
        )

    # Output
    trip_label = f"→ {dest_label}" if one_way else f"fill up and return to {home['label']}"
    print(f"\nCar:  {car['name']}  ({l_per_100km} L/100km, filling {fill_litres:.0f} L)")
    print(f"Trip: {trip_label}")
    fuel_line = f"Fuel: {fuel_label} · credit card"
    if loyalty:
        names = {p["id"]: p["name"] for p in load_loyalty_programs()}
        fuel_line += " · loyalty: " + ", ".join(names.get(p, p) for p in loyalty)
    print(fuel_line + "\n")

    col = f"{'#':>2}  {'Station':<28}  {'Address':<26}  {'Pump':>7}  {'Detour':>8}  {'Eff. ¢/L':>9}"
    print(col)
    print("─" * len(col))
    for i, r in enumerate(top, 1):
        brand = (r["brand"] or "")[:28]
        address = (r["address_line1"] or r["locality"] or "")[:26]
        tag = "  ← BEST" if i == 1 else ""
        print(
            f"{i:>2}  {brand:<28}  {address:<26}  {r['price']:>6.1f}¢"
            f"  {r['detour_km']:>6.1f} km  {r['effective_cpl']:>8.1f}¢{tag}"
        )

    best = top[0]
    print()
    if len(top) > 1:
        saving = top[1]["total_cost"] - best["total_cost"]
        print(f"Best: {best['brand']}  {best['effective_cpl']:.1f}¢/L effective"
              f"  (saves ${saving:.2f} vs #2)")
    else:
        print(f"Best: {best['brand']}  {best['effective_cpl']:.1f}¢/L effective")
    print()


if __name__ == "__main__":
    main()
