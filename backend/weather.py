from __future__ import annotations

import asyncio
from datetime import date, datetime, timezone
import math
import httpx
from .analysis import BASELINE_START, BASELINE_END
from .storage import WeatherStore

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
MAX_RESPONSE_BYTES = 4_000_000


class ProviderError(Exception):
    pass


def parse_archive(data: dict) -> tuple[list[dict], dict]:
    """Validate provider schema and units before accepting any cached data."""
    try:
        if data.get("error"):
            raise ProviderError("Weather provider rejected this request.")
        unit = data["daily_units"]["temperature_2m_max"]
        if unit not in ("°C", "C", "celsius"):
            raise ProviderError("Weather provider returned an unexpected temperature unit.")
        dates = data["daily"]["time"]
        values = data["daily"]["temperature_2m_max"]
        if not isinstance(dates, list) or not isinstance(values, list) or len(dates) != len(values) or not dates:
            raise ProviderError("Weather provider returned inconsistent daily arrays.")
        if len(dates) > 32_000:
            raise ProviderError("Weather response exceeds the supported record length.")
        for day in dates:
            date.fromisoformat(day)
        if any(value is not None and (isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value)) for value in values):
            raise ProviderError("Weather provider returned invalid numeric temperatures.")
        lat, lon = float(data["latitude"]), float(data["longitude"])
        if not math.isfinite(lat) or not math.isfinite(lon):
            raise ProviderError("Invalid model grid coordinates.")
        metadata = {"grid_latitude": lat, "grid_longitude": lon,
                    "elevation_m": data.get("elevation"), "timezone": data.get("timezone", "UTC")}
        rows = [{"date": day, "tmax": value} for day, value in zip(dates, values)]
        # Do not cache a contradictory record; normalization handles numeric outliers/nulls.
        if len(set(dates)) != len(dates):
            raise ProviderError("Weather provider returned duplicate daily dates.")
        return rows, metadata
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ProviderError("Weather provider returned an invalid daily-data format.") from exc


class WeatherService:
    def __init__(self, store: WeatherStore, client: httpx.AsyncClient):
        self.store = store
        self.client = client
        self.semaphore = asyncio.Semaphore(2)
        # Fixed lock striping bounds memory even if callers vary coordinates indefinitely.
        self.locks = [asyncio.Lock() for _ in range(32)]

    async def _json(self, url: str, params: dict) -> dict:
        # Callers choose only these two fixed origins. User input is query data, never a URL.
        if url not in (ARCHIVE_URL, GEOCODING_URL):
            raise ProviderError("Unsupported weather origin.")
        for attempt in range(3):
            try:
                async with self.semaphore:
                    async with self.client.stream("GET", url, params=params) as response:
                        if response.status_code in (429, 500, 502, 503, 504):
                            raise httpx.HTTPStatusError("Upstream temporarily unavailable", request=response.request, response=response)
                        response.raise_for_status()
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            content.extend(chunk)
                            if len(content) > MAX_RESPONSE_BYTES:
                                raise ProviderError("Weather provider response was unexpectedly large.")
                        import json
                        result = json.loads(content)
                        if not isinstance(result, dict):
                            raise ProviderError("Weather provider response was not a JSON object.")
                        return result
            except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
                if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code not in (429, 500, 502, 503, 504):
                    raise ProviderError("Weather provider could not serve this request.") from exc
                if attempt == 2:
                    raise ProviderError("Historical weather is temporarily unavailable. Please try again shortly; no synthetic data has been substituted.") from exc
                await asyncio.sleep(0.6 * (attempt + 1))
            except (ValueError, UnicodeDecodeError) as exc:
                raise ProviderError("Weather provider did not return valid JSON.") from exc
        raise ProviderError("Unable to retrieve weather data.")

    async def history(self, latitude: float, longitude: float, start_year: int, end_year: int) -> tuple[list[dict], dict]:
        # Rounding limits near-duplicate cache entries; the rounded point is also sent upstream.
        lat, lon = round(latitude, 3), round(longitude, 3)
        key = f"era5:daily-max:v1:{lat:.3f}:{lon:.3f}"
        years = list(range(min(start_year, BASELINE_START), max(end_year, BASELINE_END) + 1))
        async with self.locks[hash(key) % len(self.locks)]:
            cached = await asyncio.to_thread(self.store.get_years, key, years)
            cached_count = len(cached)
            missing = [year for year in years if year not in cached]
            if missing:
                # One bounded request for all missing years, including any already-cached years
                # in between. The public archive prices long ranges by equivalent API calls.
                first, last = min(missing), max(missing)
                data = await self._json(ARCHIVE_URL, {
                    "latitude": lat, "longitude": lon, "start_date": f"{first}-01-01", "end_date": f"{last}-12-31",
                    "daily": "temperature_2m_max", "temperature_unit": "celsius", "timezone": "auto", "models": "era5",
                })
                rows, metadata = parse_archive(data)
                if any(not first <= int(row["date"][:4]) <= last for row in rows):
                    raise ProviderError("Weather provider returned dates outside the requested years.")
                now = datetime.now(timezone.utc).timestamp()
                grouped: dict[int, list] = {year: [] for year in range(first, last + 1)}
                for row in rows:
                    grouped[int(row["date"][:4])].append(row)
                # Empty/missing years stay null during normalization; never create fake data.
                documents = [{"year": year, "rows": grouped[year], "metadata": metadata, "fetched_at": now}
                             for year in grouped]
                await asyncio.to_thread(self.store.put_years, key, documents)
                cached.update({doc["year"]: doc for doc in documents})
            output_rows = [row for year in years for row in cached[year]["rows"]]
            metadata = dict(cached[years[0]]["metadata"])
            metadata.update({"requested_latitude": lat, "requested_longitude": lon,
                             "cached_years": cached_count, "loaded_years": len(years) - cached_count,
                             "cache_policy": "30-day TinyDB document cache",
                             "model": "ERA5", "source": "Open-Meteo Historical Weather API / Copernicus ERA5",
                             "data_url": "https://open-meteo.com/en/docs/historical-weather-api",
                             "fetched_at": datetime.fromtimestamp(max(doc["fetched_at"] for doc in cached.values()), timezone.utc).isoformat()})
            return output_rows, metadata

    async def locations(self, query: str) -> list[dict]:
        data = await self._json(GEOCODING_URL, {"name": query, "count": 6, "language": "en", "format": "json"})
        try:
            results = data.get("results", [])
            if not isinstance(results, list) or len(results) > 6:
                raise ValueError("Invalid place list")
            output = []
            for item in results:
                lat, lon = float(item["latitude"]), float(item["longitude"])
                if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180:
                    raise ValueError("Invalid place coordinates")
                output.append({"id": item["id"], "name": str(item["name"]), "country": str(item.get("country", "")),
                               "admin1": str(item.get("admin1", "")), "latitude": lat, "longitude": lon})
            return output
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise ProviderError("Place search returned an invalid response. Try coordinates instead.") from exc
