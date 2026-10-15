# Heat Atlas

A React + Python climate explorer for historical heatwaves. Choose a city or coordinates, select complete calendar years, and explore annual frequency, duration and intensity. The app uses actual ERA5 daily maximum temperatures, not generated observations.

## Run locally

Requirements: Python 3.11+ and Node.js 20.19+ (Node 22.12+ or 24 recommended).

```sh
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cd frontend
npm ci
npm run build
cd ..
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Open http://127.0.0.1:8000. For frontend development, run `npm run dev` inside `frontend`; Vite proxies `/api` to port 8000. Tests: `python -m pytest -q` from the repository root.

## Deploy

The Dockerfile builds React in a Node stage and runs FastAPI as a non-root user. `PORT` defaults to 8000. Use exactly one worker: the demo's database lock and rate limiter are process-local. No API keys are required.

`render.yaml` configures a free Docker web service with `/api/health` as its health check. Import this public repository as a Render Blueprint, or create a Docker web service from it. Free services may sleep; their temporary cache can disappear on restart. The next request refetches data. A live deployment requires the owner's hosting account access; a local preview alone is not a public deployment.

```sh
docker build -t heat-atlas .
docker run --rm -p 8000:8000 -e PORT=8000 heat-atlas
```

Optional environment variables: `CACHE_DIR` (default `data/` locally, `/tmp/heat-atlas-cache` in Docker), `CORS_ORIGINS` (comma-separated, exact origins). Place a public deployment behind HTTPS. Do not enable arbitrary forwarded-header trust; configure only the actual hosting proxy if needed.

## Architecture

```text
React/TypeScript UI -> FastAPI -> WeatherService -> Open-Meteo ERA5 archive
                              -> TinyDB year documents
                              -> pure analysis functions -> JSON / annual CSV
```

- `backend/analysis.py`: calendar normalization, threshold, event detection, annual aggregation and descriptive trend calculations; independently testable.
- `backend/weather.py`: fixed-origin API requests, unit/schema validation, bounded responses, retries and per-location request coordination.
- `backend/storage.py`: NoSQL document cache, one model/location/year per document; atomic replacement and a process-local write lock.
- `backend/main.py`: validated API, request limits, CSV and production frontend delivery.
- `frontend/src/main.tsx`: city search/custom coordinates, chart controls, event inspection, accessible annual table, loading/empty/error states and methodology.

`GET /api/meta`, `/api/locations?q=Nicosia`, `/api/analyze?latitude=35.1856&longitude=33.3823&start_year=1991&end_year=2025`, `/api/export.csv` (same analysis parameters). Interactive API documentation: `/docs`.

## Data and geography

Source: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api), explicitly requesting `models=era5`, daily `temperature_2m_max`, Celsius and the location's automatic timezone. ERA5 is a consistent model-assisted reanalysis with approximately 0.25-degree grid spacing; it is not an individual station observation. Coordinates are rounded to three decimals and the returned grid coordinates are disclosed. A city means a point/grid-cell sample, not an administrative-area average. Geocoding uses [Open-Meteo's geocoding API](https://open-meteo.com/en/docs/geocoding-api).

Weather data attribution: Open-Meteo / Copernicus ERA5, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The public API is used for this noncommercial evaluation demo; commercial deployment should review the provider's current licensing and service terms. No confidential assessment document or personal application data is included in this repository.

## Detection and accounting

1. Fetch the selected years plus the full fixed **1991–2020** baseline. Select only complete calendar years (1940 through last year; at most 71 years per request).
2. Compute the **95th percentile of all valid daily maxima** in the baseline using linear interpolation (Hyndman/Fan type 7). Hold this threshold fixed when changing the selected analysis period. Require at least 95% overall baseline coverage and 90% in each baseline year.
3. A heatwave is **at least three consecutive calendar days strictly above** that threshold. Threshold equality is not exceedance. Missing/invalid days break a run; no interpolation invents events. Impossible temperatures outside -90 to 60 degrees C are missing. Conflicting duplicate dates are invalidated.
4. Detect runs across calendar-year boundaries before aggregation. An event belongs to its start year; heatwave days belong to their calendar year. An event already underway at the selected start can contribute days without a new event. Longest duration refers to events starting in the relevant period/year and may extend into another year. Runs touching missing data or the fetched record boundary are flagged as censored/lower-bound durations.
5. Intensity is mean daily exceedance above the threshold during qualifying heatwaves; peak temperature is also shown. No-event years have null intensity, not zero.
6. Frequency trend is ordinary least squares on annual counts for years with at least 95% coverage; minimum five usable years. The chart's line is a separate trailing five-year mean, present only for five complete qualifying years. The first/last five-year comparison requires at least ten selected years and sufficient coverage in both windows. Percentage change is undefined when the early mean is zero.

This is a transparent all-season study definition, not a health-warning threshold, a standardized seasonally varying climate index, or an attribution of causation. Counts may vary with data/grid resolution and threshold choice. Partial/missing years can underestimate events and are explicitly excluded from trends. Regression is descriptive, without significance or predictive claims.

## Security and reliability choices

- Numeric coordinates, year bounds, finite values, bounded place names, fixed upstream origins and no user-supplied URLs prevent arbitrary outbound destinations.
- Upstream calls have timeouts, two-request concurrency, three bounded attempts for transient errors, a 4 MB response limit, schema/unit checks and no redirects. Provider failure is visible; synthetic weather is never substituted.
- Public API limits are 8 analysis/export requests and 25 searches per IP per minute. Buckets are bounded; location locks use a fixed stripe set. Limits are demo controls rather than a distributed abuse defence.
- Cache expires after 30 days, removes expired documents on writes, and caps at 2,400 year documents. JSON writes use an atomic file replacement. A single process is required; the cache is not suitable for horizontal scaling.
- React escapes rendered strings. API responses use no-store; responses include nosniff, frame-denial and restrictive camera/microphone/geolocation permissions. No credentials, CVs or email data are stored.
- For production: shared document DB (e.g. MongoDB) with TTL/indexes, distributed quotas, persistent storage, observability, stronger deployment-specific CSP, dependency audit/updates and sustained load testing. The demo does not claim enterprise readiness.

## Validation

Tests cover strict exceedance and minimum duration, gap splitting/censoring, leap-day normalization, corrupt data, cross-year accounting, baseline rejection, zero-denominator comparisons, coverage exclusions, a known regression slope, provider validation, cache expiry/reuse, API validation and request limits. Synthetic fixtures appear only in automated tests.

A production frontend build and a real Nicosia ERA5 request were exercised locally. For 1991–2025 the initial live check returned 94 events, 451 heatwave days and 100% valid daily coverage; these are a reproducibility observation, not hardcoded UI data. Upstream revisions can change results. Docker build and public hosting are separate checks and should not be inferred from local validation.

## AI assistance disclosure

OpenAI Codex was used extensively to generate and revise the Python backend, React frontend, tests, styling and documentation, and to run local checks. The code and automated results are available for inspection. This disclosure does not claim the candidate independently authored or has already personally reviewed every part. The candidate must review the implementation, understand its tradeoffs and be ready to explain and modify it in a live interview.

## Next improvements

Add a day-of-year percentile alternative and threshold sensitivity comparison; area aggregation and a map; uncertainty and robust/statistical trend analysis; a shared MongoDB adapter; end-to-end CI, coverage reporting and monitored deployed smoke checks. Keeping one hazard and one explicit definition makes the present result inspectable within the evaluation scope.
