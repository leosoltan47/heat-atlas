from __future__ import annotations

from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date
import asyncio
import csv
import io
import os
from pathlib import Path
import time

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from .analysis import analyze
from .storage import WeatherStore
from .weather import WeatherService, ProviderError

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend" / "dist"
MAX_YEAR = date.today().year - 1


@asynccontextmanager
async def lifespan(app: FastAPI):
    store = WeatherStore(os.getenv("CACHE_DIR", str(ROOT / "data")))
    async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10), follow_redirects=False,
                                 headers={"User-Agent": "HeatAtlas/1.0 educational-case-study"}) as client:
        app.state.weather = WeatherService(store, client)
        yield
    store.close()


app = FastAPI(title="Heat Atlas", version="1.0.0", lifespan=lifespan)
origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET"], allow_headers=["Content-Type"])

# One worker per deployment: limits and document locking are intentionally process-local.
buckets: dict[tuple[str, str], deque] = defaultdict(deque)


@app.middleware("http")
async def security_and_rate_limit(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in ("/api/health", "/api/meta"):
        now = time.monotonic()
        identity = request.client.host if request.client else "unknown"
        # Ignore untrusted X-Forwarded-For headers. The app's trusted proxy config belongs
        # to the deployment; all-proxy traffic sharing a bucket is safe but restrictive.
        family = "analysis" if path in ("/api/analyze", "/api/export.csv") else "search"
        key = (identity, family)
        for old_key in list(buckets):
            if not buckets[old_key] or now - buckets[old_key][-1] >= 60:
                del buckets[old_key]
        if len(buckets) > 4096 and key not in buckets:
            return JSONResponse({"detail": "The service is busy. Please retry shortly."}, status_code=429, headers={"Retry-After": "60"})
        bucket = buckets[key]
        while bucket and now - bucket[0] >= 60:
            bucket.popleft()
        limit = 8 if family == "analysis" else 25
        if len(bucket) >= limit:
            return JSONResponse({"detail": "Too many requests. Please wait a minute before trying again."}, status_code=429, headers={"Retry-After": "60"})
        bucket.append(now)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/meta")
def metadata():
    return {"min_year": 1940, "max_year": MAX_YEAR, "baseline_start": 1991, "baseline_end": 2020,
            "hazards": ["heatwave"], "model": "ERA5"}


@app.get("/api/locations")
async def locations(request: Request, q: str = Query(min_length=2, max_length=80)):
    query = q.strip()
    if len(query) < 2 or any(ord(c) < 32 for c in query):
        raise HTTPException(422, "Enter at least two ordinary characters for a place name.")
    try:
        return {"locations": await request.app.state.weather.locations(query)}
    except ProviderError as exc:
        raise HTTPException(502, str(exc)) from exc


async def get_analysis(request: Request, latitude: float, longitude: float, start_year: int, end_year: int):
    if start_year > end_year:
        raise HTTPException(422, "Start year must not be later than end year.")
    if end_year - start_year > 70:
        raise HTTPException(422, "Choose a period of at most 71 calendar years.")
    try:
        rows, provenance = await request.app.state.weather.history(latitude, longitude, start_year, end_year)
        result = await asyncio.to_thread(analyze, rows, start_year, end_year)
        result["provenance"] = provenance
        return result
    except ProviderError as exc:
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/analyze")
async def analysis(request: Request,
                   latitude: float = Query(ge=-90, le=90, allow_inf_nan=False),
                   longitude: float = Query(ge=-180, le=180, allow_inf_nan=False),
                   start_year: int = Query(ge=1940, le=MAX_YEAR), end_year: int = Query(ge=1940, le=MAX_YEAR)):
    return await get_analysis(request, latitude, longitude, start_year, end_year)


@app.get("/api/export.csv")
async def export(request: Request,
                 latitude: float = Query(ge=-90, le=90, allow_inf_nan=False),
                 longitude: float = Query(ge=-180, le=180, allow_inf_nan=False),
                 start_year: int = Query(ge=1940, le=MAX_YEAR), end_year: int = Query(ge=1940, le=MAX_YEAR)):
    result = await get_analysis(request, latitude, longitude, start_year, end_year)
    buffer = io.StringIO(newline="")
    columns = ["year", "events", "heatwave_days", "longest_event_days", "mean_excess_c", "peak_c", "coverage_pct", "included_in_trend", "rolling_events"]
    writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(result["yearly"])
    return Response(buffer.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="heat-atlas-annual.csv"'})


if (FRONTEND / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path.startswith("api/") or path.startswith("assets/"):
        raise HTTPException(404, "Not found")
    if not (FRONTEND / "index.html").exists():
        raise HTTPException(503, "Frontend not built. Run npm run build in frontend, or use the Vite development server.")
    return FileResponse(FRONTEND / "index.html")
