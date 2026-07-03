from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
LOG_DIR = ROOT_DIR / "logs"
DB_PATH = DATA_DIR / "gasbuddy.db"
DEFAULT_HOST = os.getenv("GASWATCH_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("GASWATCH_PORT", "20443"))
DEFAULT_TIMEOUT = int(os.getenv("GASWATCH_TIMEOUT", "30"))
DEFAULT_MAX_AGE_HOURS = int(os.getenv("GASWATCH_MAX_AGE_HOURS", "0"))
DEFAULT_MAX_PAGES = int(os.getenv("GASWATCH_MAX_PAGES", "1"))
DEFAULT_PAGE_DELAY = float(os.getenv("GASWATCH_PAGE_DELAY", "2.0"))
DEFAULT_CITY_DELAY = float(os.getenv("GASWATCH_CITY_DELAY", "15.0"))
DEFAULT_RETRIES = int(os.getenv("GASWATCH_RETRIES", "2"))
DEFAULT_RETRY_DELAY = float(os.getenv("GASWATCH_RETRY_DELAY", "30.0"))

FUEL_PRODUCTS = {"regular_gas", "midgrade_gas", "premium_gas", "diesel"}


@dataclass(frozen=True)
class City:
    name: str
    province: str
    slug: str
    url: str
    latitude: float
    longitude: float


CITIES = [
    City("Richmond", "British Columbia", "richmond", "https://www.gasbuddy.com/gasprices/british-columbia/richmond", 49.1666, -123.1336),
    City("Vancouver", "British Columbia", "vancouver", "https://www.gasbuddy.com/gasprices/british-columbia/vancouver", 49.2827, -123.1207),
    City("Burnaby", "British Columbia", "burnaby", "https://www.gasbuddy.com/gasprices/british-columbia/burnaby", 49.2488, -122.9805),
    City("Delta", "British Columbia", "delta", "https://www.gasbuddy.com/gasprices/british-columbia/delta", 49.0952, -123.0265),
    City("Surrey", "British Columbia", "surrey", "https://www.gasbuddy.com/gasprices/british-columbia/surrey", 49.1913, -122.8490),
    City("New Westminster", "British Columbia", "new-westminster", "https://www.gasbuddy.com/gasprices/british-columbia/new-westminster", 49.2057, -122.9110),
    City("Ladner", "British Columbia", "ladner", "https://www.gasbuddy.com/gasprices/british-columbia/ladner", 49.0894, -123.0824),
    City("Tsawwassen", "British Columbia", "tsawwassen", "https://www.gasbuddy.com/gasprices/british-columbia/tsawwassen", 49.0253, -123.0780),
    City("White Rock", "British Columbia", "white-rock", "https://www.gasbuddy.com/gasprices/british-columbia/white-rock", 49.0253, -122.8029),
    City("Coquitlam", "British Columbia", "coquitlam", "https://www.gasbuddy.com/gasprices/british-columbia/coquitlam", 49.2838, -122.7932),
    City("Port Coquitlam", "British Columbia", "port-coquitlam", "https://www.gasbuddy.com/gasprices/british-columbia/port-coquitlam", 49.2628, -122.7811),
    City("Aldergrove", "British Columbia", "aldergrove", "https://www.gasbuddy.com/gasprices/british-columbia/aldergrove", 49.0580, -122.4709),
    City("Langley", "British Columbia", "langley", "https://www.gasbuddy.com/gasprices/british-columbia/langley", 49.1044, -122.6604),
    City("Port Moody", "British Columbia", "port-moody", "https://www.gasbuddy.com/gasprices/british-columbia/port-moody", 49.2837, -122.8316),
    City("Abbotsford", "British Columbia", "abbotsford", "https://www.gasbuddy.com/gasprices/british-columbia/abbotsford", 49.0504, -122.3045),
    City("Victoria", "British Columbia", "victoria", "https://www.gasbuddy.com/gasprices/british-columbia/victoria", 48.4284, -123.3656),
    City("Saanich", "British Columbia", "saanich", "https://www.gasbuddy.com/gasprices/british-columbia/saanich", 48.4836, -123.3676),
    City("Oak Bay", "British Columbia", "oak-bay", "https://www.gasbuddy.com/gasprices/british-columbia/oak-bay", 48.4255, -123.3194),
    City("Esquimalt", "British Columbia", "esquimalt", "https://www.gasbuddy.com/gasprices/british-columbia/esquimalt", 48.4359, -123.4286),
    City("Langford", "British Columbia", "langford", "https://www.gasbuddy.com/gasprices/british-columbia/langford", 48.4500, -123.5044),
    City("Colwood", "British Columbia", "colwood", "https://www.gasbuddy.com/gasprices/british-columbia/colwood", 48.4284, -123.4955),
    City("View Royal", "British Columbia", "view-royal", "https://www.gasbuddy.com/gasprices/british-columbia/view-royal", 48.4497, -123.4427),
    City("Central Saanich", "British Columbia", "central-saanich", "https://www.gasbuddy.com/gasprices/british-columbia/central-saanich", 48.5483, -123.4170),
    City("North Saanich", "British Columbia", "north-saanich", "https://www.gasbuddy.com/gasprices/british-columbia/north-saanich", 48.6109, -123.4270),
    City("Sidney", "British Columbia", "sidney", "https://www.gasbuddy.com/gasprices/british-columbia/sidney", 48.6501, -123.3984),
    City("Sooke", "British Columbia", "sooke", "https://www.gasbuddy.com/gasprices/british-columbia/sooke", 48.3764, -123.7276),
    City("Saanich Peninsula", "British Columbia", "saanich-peninsula", "https://www.gasbuddy.com/gasprices/british-columbia/saanich-peninsula", 48.6044, -123.4197),
    City("Western Communities", "British Columbia", "western-communities", "https://www.gasbuddy.com/gasprices/british-columbia/western-communities", 48.4533, -123.5200),
    City("James Bay", "British Columbia", "james-bay", "https://www.gasbuddy.com/gasprices/british-columbia/james-bay", 48.4122, -123.3780),
    City("Fairfield", "British Columbia", "fairfield", "https://www.gasbuddy.com/gasprices/british-columbia/fairfield", 48.4172, -123.3439),
]
