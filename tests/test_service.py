import asyncio
from datetime import datetime, timezone
import httpx
import pytest
from fastapi.testclient import TestClient
from backend.main import app, buckets
from backend.storage import WeatherStore
from backend.weather import WeatherService, ProviderError, parse_archive


def archive():
    return {"latitude": 35.2, "longitude": 33.4, "timezone": "Asia/Nicosia", "daily_units": {"temperature_2m_max": "°C"},
            "daily": {"time": ["1991-01-01", "2020-12-31"], "temperature_2m_max": [15.2, 17.8]}}


def test_provider_schema_and_units():
    value = archive()
    assert len(parse_archive(value)[0]) == 2
    value["daily_units"]["temperature_2m_max"] = "°F"
    with pytest.raises(ProviderError):
        parse_archive(value)


def test_provider_rejects_non_finite_temperature_before_persistence():
    value = archive()
    value["daily"]["temperature_2m_max"][0] = float("nan")
    with pytest.raises(ProviderError, match="numeric"):
        parse_archive(value)


def test_cache_round_trip_and_expiry(tmp_path):
    store = WeatherStore(str(tmp_path))
    now = datetime.now(timezone.utc).timestamp()
    store.put_years("point", [{"year": 2020, "rows": [], "metadata": {}, "fetched_at": now}])
    assert 2020 in store.get_years("point", [2020])
    store.put_years("point", [{"year": 2020, "rows": [], "metadata": {}, "fetched_at": now - 31 * 86400}])
    assert store.get_years("point", [2020]) == {}
    store.close()


def test_second_analysis_reuses_nosql_cache(tmp_path):
    async def scenario():
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json=archive())
        store = WeatherStore(str(tmp_path))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            service = WeatherService(store, client)
            first = await service.history(35.1856, 33.3823, 2000, 2010)
            second = await service.history(35.1856, 33.3823, 2000, 2010)
            assert len(requests) == 1
            assert requests[0].url.params["models"] == "era5"
            assert requests[0].url.params["latitude"] == "35.186"
            assert first[1]["loaded_years"] == 30
            assert second[1]["cached_years"] == 30
            assert first[0] == second[0]
        store.close()
    asyncio.run(scenario())


def test_api_validation_headers_and_rate_limit(monkeypatch, tmp_path):
    monkeypatch.setenv("CACHE_DIR", str(tmp_path))
    buckets.clear()
    with TestClient(app) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.headers["x-content-type-options"] == "nosniff"
        for latitude in ("nan", "inf", "91"):
            response = client.get(f"/api/analyze?latitude={latitude}&longitude=33&start_year=2000&end_year=2020")
            assert response.status_code == 422
        assert client.get("/api/analyze?latitude=35&longitude=33&start_year=2020&end_year=2000").status_code == 422
        for _ in range(4):
            assert client.get("/api/analyze").status_code == 422
        response = client.get("/api/analyze")
        assert response.status_code == 429
        assert response.headers["retry-after"] == "60"
    buckets.clear()
