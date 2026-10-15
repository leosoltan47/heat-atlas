import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Database,
  Globe2,
  LoaderCircle,
  MapPin,
  Search,
  Sun,
  Thermometer,
  TriangleAlert,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./styles.css";

type Region = {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  id?: number;
};
type Annual = {
  year: number;
  events: number;
  heatwave_days: number;
  longest_event_days: number;
  mean_excess_c: number | null;
  peak_c: number | null;
  valid_days: number;
  missing_days: number;
  coverage_pct: number;
  included_in_trend: boolean;
  rolling_events: number | null;
  trend_events: number | null;
};
type HeatEvent = {
  start: string;
  end: string;
  duration: number;
  peak_c: number;
  mean_excess_c: number;
  censored: boolean;
};
type Result = {
  period: { start_year: number; end_year: number };
  definition: {
    threshold_c: number;
    baseline_start: number;
    baseline_end: number;
  };
  yearly: Annual[];
  events: HeatEvent[];
  summary: {
    total_events: number;
    total_heatwave_days: number;
    longest_event_days: number;
    peak_c: number | null;
  };
  trend: {
    slope_per_decade: number;
    r_squared: number | null;
    years_used: number;
  } | null;
  comparison: {
    early_mean: number;
    recent_mean: number;
    absolute_change: number;
    percent_change: number | null;
    early_years: string;
    recent_years: string;
  } | null;
  quality: {
    valid_days: number;
    expected_days: number;
    baseline_coverage_pct: number;
    invalid_values: number;
    duplicate_dates: number;
    invalid_dates: number;
    censored_events: number;
    excluded_years: number[];
  };
  provenance: {
    model: string;
    grid_latitude: number;
    grid_longitude: number;
    requested_latitude: number;
    requested_longitude: number;
    timezone: string;
    cached_years: number;
    loaded_years: number;
    fetched_at: string;
  };
  warnings: string[];
  accounting: string;
};
const PRESETS: Region[] = [
  { name: "Nicosia", country: "Cyprus", latitude: 35.1856, longitude: 33.3823 },
  {
    name: "Bucharest",
    country: "Romania",
    latitude: 44.4268,
    longitude: 26.1025,
  },
  {
    name: "London",
    country: "United Kingdom",
    latitude: 51.5074,
    longitude: -0.1278,
  },
];
const format = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { maximumFractionDigits: digits });
const signed = (value: number, digits = 1) =>
  `${value > 0 ? "+" : ""}${format(value, digits)}`;
const niceDate = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value + "T12:00:00Z"));
const paramsFor = (region: Region, start: number, end: number) =>
  new URLSearchParams({
    latitude: String(region.latitude),
    longitude: String(region.longitude),
    start_year: String(start),
    end_year: String(end),
  });

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : response.status === 422
          ? "Check the coordinates and year range, then try again."
          : "The service could not complete this request. Please try again.",
    );
  return body as T;
}

function App() {
  const [region, setRegion] = useState<Region>(PRESETS[0]);
  const [mode, setMode] = useState<"city" | "coordinates">("city");
  const [lat, setLat] = useState("35.1856");
  const [lon, setLon] = useState("33.3823");
  const [search, setSearch] = useState("");
  const [locations, setLocations] = useState<Region[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [start, setStart] = useState(1991);
  const [end, setEnd] = useState(new Date().getFullYear() - 1);
  const [maxYear, setMaxYear] = useState(new Date().getFullYear() - 1);
  const [result, setResult] = useState<Result | null>(null);
  const [activeRegion, setActiveRegion] = useState<Region>(PRESETS[0]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState<
    "events" | "heatwave_days" | "longest_event_days"
  >("events");
  const [selectedYear, setSelectedYear] = useState(end);
  const [showAnnual, setShowAnnual] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);

  async function load(chosen: Region, first: number, last: number) {
    const id = ++requestNumber.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await readJson<Result>(
        `/api/analyze?${paramsFor(chosen, first, last)}`,
        abort.signal,
      );
      if (id !== requestNumber.current) return;
      setResult(data);
      setActiveRegion(chosen);
      setSelectedYear(last);
    } catch (e) {
      if (!abort.signal.aborted && id === requestNumber.current)
        setError(e instanceof Error ? e.message : "Unable to load analysis.");
    } finally {
      if (id === requestNumber.current) setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    readJson<{ max_year: number }>("/api/meta")
      .then((meta) => {
        if (!alive) return;
        setMaxYear(meta.max_year);
        setEnd(meta.max_year);
        void load(PRESETS[0], 1991, meta.max_year);
      })
      .catch((e) => {
        if (alive) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      controller.current?.abort();
      searchController.current?.abort();
    };
  }, []);

  async function findCity() {
    const term = search.trim();
    if (term.length < 2) {
      setSearchError("Enter at least two characters.");
      return;
    }
    searchController.current?.abort();
    const abort = new AbortController();
    searchController.current = abort;
    setSearching(true);
    setSearchError("");
    setLocations(null);
    try {
      const data = await readJson<{ locations: Region[] }>(
        `/api/locations?q=${encodeURIComponent(term)}`,
        abort.signal,
      );
      if (!abort.signal.aborted) setLocations(data.locations);
    } catch (e) {
      if (!abort.signal.aborted)
        setSearchError(e instanceof Error ? e.message : "Place search failed.");
    } finally {
      if (!abort.signal.aborted) setSearching(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const chosen =
      mode === "city"
        ? region
        : {
            name: "Custom location",
            country: "",
            latitude: Number(lat),
            longitude: Number(lon),
          };
    if (
      mode === "coordinates" &&
      (!lat.trim() ||
        !lon.trim() ||
        !Number.isFinite(chosen.latitude) ||
        !Number.isFinite(chosen.longitude) ||
        Math.abs(chosen.latitude) > 90 ||
        Math.abs(chosen.longitude) > 180)
    ) {
      setError(
        "Enter latitude between -90 and 90, and longitude between -180 and 180.",
      );
      return;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1940 ||
      end > maxYear ||
      start > end ||
      end - start > 70
    ) {
      setError(
        `Choose an ordered period from 1940 to ${maxYear}, no longer than 71 years.`,
      );
      return;
    }
    void load(chosen, start, end);
  }

  const currentRegion =
    mode === "city"
      ? region
      : {
          name: "Custom location",
          country: "",
          latitude: Number(lat),
          longitude: Number(lon),
        };
  const changed =
    result &&
    (start !== result.period.start_year ||
      end !== result.period.end_year ||
      Math.abs(currentRegion.latitude - activeRegion.latitude) > 0.0001 ||
      Math.abs(currentRegion.longitude - activeRegion.longitude) > 0.0001);
  const selected = result?.yearly.find((row) => row.year === selectedYear);
  const yearEvents =
    result?.events.filter(
      (event) => Number(event.start.slice(0, 4)) === selectedYear,
    ) ?? [];
  const metricLabel =
    metric === "events"
      ? "Heatwave events"
      : metric === "heatwave_days"
        ? "Heatwave days"
        : "Longest event (days)";
  const chartData = result?.yearly.map((row) => ({
    ...row,
    plotted: row.included_in_trend ? row[metric] : null,
  }));
  const qualityPct = result
    ? (100 * result.quality.valid_days) / result.quality.expected_days
    : 0;
  const comparison = result?.comparison;

  return (
    <>
      <a className="skip" href="#analysis">
        Skip to analysis
      </a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Heat Atlas home">
          <span className="brand-icon">
            <Sun size={21} />
          </span>
          heat<span>atlas</span>
        </a>
        <div className="topnote">
          <Globe2 size={15} /> Historical climate, made legible
        </div>
        <a className="method-link" href="#methodology">
          How it works <ArrowRight size={15} />
        </a>
      </header>
      <main className="page">
        <div className="intro">
          <div>
            <div className="eyebrow">
              CLIMATE HAZARD EXPLORER <span>01 / HEATWAVES</span>
            </div>
            <h1>A clearer picture of extreme heat.</h1>
            <p>Explore how heatwaves have changed in a place you care about.</p>
          </div>
          <div className="source-pill">
            <span /> ERA5 reanalysis <span className="separator">/</span> 1940–
            {maxYear}
          </div>
        </div>
        <div className="workspace">
          <aside className="controls">
            <form onSubmit={submit}>
              <div className="panel-title">
                <MapPin size={17} />
                <h2>Choose your region</h2>
              </div>
              <div className="segmented" aria-label="Region input mode">
                <button
                  type="button"
                  className={mode === "city" ? "active" : ""}
                  aria-pressed={mode === "city"}
                  onClick={() => setMode("city")}
                >
                  City search
                </button>
                <button
                  type="button"
                  className={mode === "coordinates" ? "active" : ""}
                  aria-pressed={mode === "coordinates"}
                  onClick={() => setMode("coordinates")}
                >
                  Coordinates
                </button>
              </div>
              {mode === "city" ? (
                <>
                  <label htmlFor="city">Find a city</label>
                  <div className="searchbox">
                    <Search size={16} />
                    <input
                      id="city"
                      value={search}
                      placeholder="City or town name"
                      maxLength={80}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setLocations(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void findCity();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void findCity()}
                      disabled={searching}
                      aria-label="Search cities"
                    >
                      {searching ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <ArrowRight size={16} />
                      )}
                    </button>
                  </div>
                  {searchError && (
                    <p className="field-error" role="alert">
                      {searchError}
                    </p>
                  )}
                  {locations && (
                    <div className="location-results" aria-live="polite">
                      {locations.length === 0 ? (
                        <p>
                          No matching places. Try another name or use
                          coordinates.
                        </p>
                      ) : (
                        locations.map((place) => (
                          <button
                            type="button"
                            key={place.id}
                            onClick={() => {
                              setRegion(place);
                              setLocations(null);
                              setSearch("");
                            }}
                          >
                            <strong>{place.name}</strong>
                            <span>
                              {[place.admin1, place.country]
                                .filter(Boolean)
                                .join(", ")}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  <div className="selected-place">
                    <MapPin size={17} />
                    <div>
                      <strong>{region.name}</strong>
                      <span>
                        {region.country} · {region.latitude.toFixed(3)},{" "}
                        {region.longitude.toFixed(3)}
                      </span>
                    </div>
                    <Check size={15} />
                  </div>
                  <div className="preset-title">
                    Or start somewhere familiar
                  </div>
                  <div className="presets">
                    {PRESETS.map((place) => (
                      <button
                        key={place.name}
                        type="button"
                        className={region.name === place.name ? "selected" : ""}
                        onClick={() => {
                          setRegion(place);
                          setLocations(null);
                        }}
                      >
                        {place.name}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="coordinate-grid">
                  <div>
                    <label htmlFor="latitude">Latitude</label>
                    <input
                      id="latitude"
                      type="number"
                      min="-90"
                      max="90"
                      step="any"
                      value={lat}
                      onChange={(e) => setLat(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="longitude">Longitude</label>
                    <input
                      id="longitude"
                      type="number"
                      min="-180"
                      max="180"
                      step="any"
                      value={lon}
                      onChange={(e) => setLon(e.target.value)}
                    />
                  </div>
                  <p className="hint">
                    A point sample of the nearest ERA5 grid cell, not an
                    area-wide average.
                  </p>
                </div>
              )}
              <div className="divider" />
              <label htmlFor="hazard">Climate hazard</label>
              <div className="hazard">
                <Thermometer size={18} />
                <select id="hazard" value="heatwave" onChange={() => {}}>
                  <option value="heatwave">Heatwave</option>
                </select>
                <span>ACTIVE</span>
              </div>
              <label>Analysis period</label>
              <div className="year-grid">
                <div>
                  <label htmlFor="start">From</label>
                  <input
                    id="start"
                    type="number"
                    min="1940"
                    max={maxYear}
                    value={start}
                    onChange={(e) => setStart(Number(e.target.value))}
                  />
                </div>
                <span>–</span>
                <div>
                  <label htmlFor="end">To</label>
                  <input
                    id="end"
                    type="number"
                    min="1940"
                    max={maxYear}
                    value={end}
                    onChange={(e) => setEnd(Number(e.target.value))}
                  />
                </div>
              </div>
              <p className="hint">
                Full calendar years only. Up to 71 years per analysis.
              </p>
              <button
                className="primary analyze-button"
                type="submit"
                disabled={loading}
              >
                {loading ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Activity size={17} />
                )}{" "}
                {loading ? "Analyzing history…" : "Analyze heatwaves"}
                {!loading && <ArrowRight size={17} />}
              </button>
              {changed && (
                <p className="pending">
                  <span /> Apply your changes to update the results.
                </p>
              )}
              <div className="baseline-note">
                <CircleHelp size={16} />
                <p>
                  One consistent benchmark.
                  <br />
                  <span>
                    95th percentile, fixed to 1991–2020. The baseline stays the
                    same when you change the analysis years.
                  </span>
                </p>
              </div>
            </form>
            <div className="sidebar-source">
              <Database size={15} />
              <p>
                Real historical data.
                <br />
                <span>No synthetic observations or forecasts.</span>
              </p>
            </div>
          </aside>

          <section id="analysis" className="analysis" aria-busy={loading}>
            {loading && (
              <div className="loading-state" role="status">
                <div className="loading-mark">
                  <Sun size={34} />
                  <LoaderCircle className="spin" size={62} />
                </div>
                <h2>Reading the climate record</h2>
                <p>
                  Loading daily temperatures, checking data quality, and
                  detecting consecutive hot days.
                </p>
                <span>
                  A new location may take a little longer. Previously loaded
                  years are cached.
                </span>
              </div>
            )}
            {error && !loading && (
              <div className="error-state" role="alert">
                <TriangleAlert size={28} />
                <h2>We couldn’t finish this analysis</h2>
                <p>{error}</p>
                <p className="hint">
                  No estimates or sample data have been substituted.
                </p>
                <button
                  className="primary"
                  onClick={() => void load(currentRegion, start, end)}
                >
                  Try again
                </button>
              </div>
            )}
            {result && !loading && (
              <>
                <div className="result-header">
                  <div className="result-location">
                    <span className="location-dot" />
                    <h2>
                      {activeRegion.name}
                      <span>
                        {activeRegion.country
                          ? `, ${activeRegion.country}`
                          : ""}
                      </span>
                    </h2>
                    <p>
                      {result.period.start_year}–{result.period.end_year}
                    </p>
                  </div>
                  <a
                    className="export"
                    href={`/api/export.csv?${paramsFor(activeRegion, result.period.start_year, result.period.end_year)}`}
                  >
                    <ArrowDownToLine size={15} /> Export annual data
                  </a>
                </div>
                <div className="metrics">
                  <Metric
                    label="HEATWAVE EVENTS"
                    value={format(result.summary.total_events)}
                    sub="Events starting in this period"
                  />
                  <Metric
                    label="DAYS IN HEATWAVES"
                    value={format(result.summary.total_heatwave_days)}
                    sub="Within the selected calendar years"
                  />
                  <Metric
                    label="LONGEST EVENT"
                    value={String(result.summary.longest_event_days)}
                    suffix="days"
                    sub="For events starting in this period"
                  />
                  <Metric
                    label="LOCAL HEAT THRESHOLD"
                    value={format(result.definition.threshold_c, 1)}
                    suffix="°C"
                    sub="95th percentile · 1991–2020"
                  />
                </div>
                <div className="insight">
                  <span className="insight-icon">
                    <Activity size={19} />
                  </span>
                  <div>
                    <h3>
                      {result.trend
                        ? `${signed(result.trend.slope_per_decade, 2)} events per decade`
                        : "Not enough complete years for a trend"}
                    </h3>
                    <p>
                      {result.trend
                        ? `The fitted trend in annual frequency across ${result.trend.years_used} sufficiently complete years. A descriptive pattern, not a forecast or a causal claim.`
                        : "Explore at least five years with sufficient data coverage to estimate a descriptive trend."}
                    </p>
                  </div>
                </div>
                <div className="chart-panel">
                  <div className="chart-heading">
                    <div>
                      <span className="eyebrow">THE LONG VIEW</span>
                      <h3>How often, and how long?</h3>
                      <p>
                        Annual heatwave activity, measured against a fixed local
                        threshold.
                      </p>
                    </div>
                    <div className="metric-tabs" aria-label="Chart measure">
                      {(
                        [
                          "events",
                          "heatwave_days",
                          "longest_event_days",
                        ] as const
                      ).map((key) => (
                        <button
                          key={key}
                          aria-pressed={metric === key}
                          className={metric === key ? "active" : ""}
                          onClick={() => setMetric(key)}
                        >
                          {key === "events"
                            ? "Frequency"
                            : key === "heatwave_days"
                              ? "Heatwave days"
                              : "Duration"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="axis-label">{metricLabel}</div>
                  <div
                    className="main-chart"
                    role="img"
                    aria-label={`Annual ${metricLabel.toLowerCase()} from ${result.period.start_year} to ${result.period.end_year}. Equivalent values are available in the annual data table below.`}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={chartData}
                        margin={{ top: 8, right: 12, bottom: 3, left: -25 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 5"
                          vertical={false}
                          stroke="#e5e9e7"
                        />
                        <XAxis
                          dataKey="year"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "#74817e", fontSize: 11 }}
                          minTickGap={30}
                        />
                        <YAxis
                          allowDecimals={metric !== "events"}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "#74817e", fontSize: 11 }}
                        />
                        <Tooltip
                          content={({ active, payload, label }) =>
                            active && payload?.length ? (
                              <div className="chart-tooltip">
                                <strong>{label}</strong>
                                <span>
                                  {metricLabel}:{" "}
                                  {format(
                                    Number(
                                      payload.find(
                                        (p) => p.dataKey === "plotted",
                                      )?.value ?? 0,
                                    ),
                                    1,
                                  )}
                                </span>
                                {metric === "events" &&
                                  payload.find(
                                    (p) => p.dataKey === "rolling_events",
                                  )?.value != null && (
                                    <span>
                                      5-year mean:{" "}
                                      {format(
                                        Number(
                                          payload.find(
                                            (p) =>
                                              p.dataKey === "rolling_events",
                                          )?.value,
                                        ),
                                        2,
                                      )}
                                    </span>
                                  )}
                              </div>
                            ) : null
                          }
                        />
                        <Bar
                          dataKey="plotted"
                          name={metricLabel}
                          fill="#e99362"
                          radius={[3, 3, 0, 0]}
                          maxBarSize={28}
                          onClick={(data) => {
                            const year = (
                              data as { payload?: { year?: number } }
                            ).payload?.year;
                            if (year) setSelectedYear(year);
                          }}
                        />
                        {metric === "events" && (
                          <Line
                            dataKey="rolling_events"
                            name="5-year trailing mean"
                            type="linear"
                            stroke="#183f48"
                            strokeWidth={2.7}
                            dot={false}
                            connectNulls={false}
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="chart-footer">
                    <div className="legend">
                      <span>
                        <i className="bar-key" />
                        {metricLabel}
                      </span>
                      {metric === "events" && (
                        <span>
                          <i className="line-key" />
                          5-year trailing mean
                        </span>
                      )}
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setShowAnnual(!showAnnual)}
                      aria-expanded={showAnnual}
                    >
                      Annual data{" "}
                      <ChevronDown
                        size={14}
                        className={showAnnual ? "rotate" : ""}
                      />
                    </button>
                  </div>
                  {showAnnual && (
                    <div className="table-scroll">
                      <table>
                        <caption>
                          Annual observations. Years below 95% coverage are
                          excluded from the trend and plotted bars.
                        </caption>
                        <thead>
                          <tr>
                            <th>Year</th>
                            <th>Events</th>
                            <th>Heatwave days</th>
                            <th>Longest (days)</th>
                            <th>Mean excess (°C)</th>
                            <th>Coverage</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.yearly.map((row) => (
                            <tr key={row.year}>
                              <th scope="row">{row.year}</th>
                              <td>{row.events}</td>
                              <td>{row.heatwave_days}</td>
                              <td>{row.longest_event_days}</td>
                              <td>
                                {row.mean_excess_c == null
                                  ? "—"
                                  : format(row.mean_excess_c, 2)}
                              </td>
                              <td>
                                {format(row.coverage_pct, 1)}%
                                {!row.included_in_trend && " (excluded)"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div className="lower-grid">
                  <div className="chart-panel intensity">
                    <span className="eyebrow">BEYOND THE COUNT</span>
                    <h3>How intense were the events?</h3>
                    <p>
                      Average daily temperature above the threshold, during
                      heatwaves.
                    </p>
                    <div className="axis-label">
                      Mean excess temperature (°C)
                    </div>
                    <div
                      className="small-chart"
                      role="img"
                      aria-label="Annual mean excess temperature during heatwaves. Values are included in the annual data table."
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={result.yearly}
                          margin={{ top: 8, right: 8, left: -25, bottom: 0 }}
                        >
                          <CartesianGrid
                            vertical={false}
                            strokeDasharray="3 5"
                            stroke="#e5e9e7"
                          />
                          <XAxis
                            dataKey="year"
                            axisLine={false}
                            tickLine={false}
                            minTickGap={40}
                            tick={{ fontSize: 10, fill: "#74817e" }}
                          />
                          <YAxis
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 10, fill: "#74817e" }}
                          />
                          <Tooltip
                            formatter={(value) => [
                              `${format(Number(value), 2)} °C`,
                              "Mean excess",
                            ]}
                            contentStyle={{
                              borderRadius: 8,
                              borderColor: "#dce4df",
                              fontSize: 12,
                            }}
                          />
                          <Line
                            dataKey="mean_excess_c"
                            type="linear"
                            stroke="#bb724f"
                            strokeWidth={2}
                            dot={{ r: 2, fill: "#bb724f" }}
                            connectNulls={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="chart-caption">
                      A gap means no detected event that year, not zero
                      intensity.
                    </p>
                  </div>
                  <div className="comparison-panel">
                    <span className="eyebrow">THEN & NOW</span>
                    <h3>A fairer comparison.</h3>
                    <p>
                      Five-year averages soften the effect of an unusually hot
                      or quiet single year.
                    </p>
                    {comparison ? (
                      <>
                        <div className="comparison-bars">
                          <ComparisonBar
                            label={comparison.early_years}
                            value={comparison.early_mean}
                            max={Math.max(
                              comparison.early_mean,
                              comparison.recent_mean,
                              1,
                            )}
                            early
                          />
                          <ComparisonBar
                            label={comparison.recent_years}
                            value={comparison.recent_mean}
                            max={Math.max(
                              comparison.early_mean,
                              comparison.recent_mean,
                              1,
                            )}
                          />
                        </div>
                        <div className="comparison-change">
                          <strong>
                            {comparison.percent_change == null
                              ? signed(comparison.absolute_change, 1)
                              : `${signed(comparison.percent_change, 0)}%`}
                          </strong>
                          <span>
                            {comparison.percent_change == null
                              ? "events/year change; percentage is undefined because the earlier mean is zero."
                              : "change in average events per year between these windows."}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="empty-comparison">
                        <CircleHelp size={22} />
                        <p>
                          Select at least ten years with sufficient coverage in
                          both five-year windows.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="chart-panel events-panel">
                  <div className="events-heading">
                    <div>
                      <span className="eyebrow">LOOK CLOSER</span>
                      <h3>Inside a year.</h3>
                      <p>
                        Events are counted in the year they begin. Select a year
                        or click a chart bar.
                      </p>
                    </div>
                    <label className="year-select">
                      Year
                      <select
                        value={selectedYear}
                        onChange={(e) =>
                          setSelectedYear(Number(e.target.value))
                        }
                      >
                        {result.yearly.map((row) => (
                          <option key={row.year} value={row.year}>
                            {row.year}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="year-stats">
                    <span>
                      <b>{selected?.events}</b> events started
                    </span>
                    <span>
                      <b>{selected?.heatwave_days}</b> heatwave days
                    </span>
                    <span>
                      <b>
                        {selected?.peak_c == null
                          ? "—"
                          : `${format(selected.peak_c, 1)} °C`}
                      </b>{" "}
                      peak during heatwaves
                    </span>
                  </div>
                  {yearEvents.length ? (
                    <div className="table-scroll">
                      <table>
                        <caption className="visually-hidden">
                          Heatwaves starting in {selectedYear}
                        </caption>
                        <thead>
                          <tr>
                            <th>Dates</th>
                            <th>Duration</th>
                            <th>Peak</th>
                            <th>Mean excess</th>
                          </tr>
                        </thead>
                        <tbody>
                          {yearEvents.map((event) => (
                            <tr key={event.start}>
                              <th scope="row">
                                {niceDate(event.start)} – {niceDate(event.end)}
                                {event.censored && (
                                  <span title="Touches missing data or the available record boundary">
                                    {" "}
                                    *
                                  </span>
                                )}
                              </th>
                              <td>{event.duration} days</td>
                              <td>{format(event.peak_c, 1)} °C</td>
                              <td>+{format(event.mean_excess_c, 2)} °C</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="no-events">
                      No qualifying heatwaves started in {selectedYear}.
                      {selected?.missing_days
                        ? " Missing observations may affect detection."
                        : ""}
                    </div>
                  )}
                </div>
                <div className="quality-strip">
                  <Check size={17} />
                  <span>
                    <strong>
                      {format(qualityPct, 1)}% valid daily coverage
                    </strong>{" "}
                    · {format(result.quality.valid_days)} of{" "}
                    {format(result.quality.expected_days)} days
                  </span>
                  <span className="quality-cache">
                    {result.provenance.loaded_years === 0
                      ? "Loaded from historical cache"
                      : "Historical data retrieved"}
                  </span>
                </div>
                <section className="methodology" id="methodology">
                  <div className="method-title">
                    <h3>Read the method, not just the chart.</h3>
                    <span>TRANSPARENT BY DESIGN</span>
                  </div>
                  <details open>
                    <summary>What counts as a heatwave?</summary>
                    <p>
                      At least three consecutive calendar days with daily
                      maximum temperature{" "}
                      <strong>
                        strictly above{" "}
                        {format(result.definition.threshold_c, 2)} °C
                      </strong>
                      . This threshold is the linearly interpolated 95th
                      percentile of all valid daily maxima from 1991–2020, held
                      fixed for every analysis period. Missing or invalid days
                      break a run; they are never interpolated.
                    </p>
                  </details>
                  <details>
                    <summary>Data, geography & caching</summary>
                    <p>
                      Source:{" "}
                      <a
                        href="https://open-meteo.com/en/docs/historical-weather-api"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open-Meteo Historical Weather API
                      </a>
                      , using the consistent Copernicus ERA5 reanalysis model.
                      Reanalysis is a model-assisted historical reconstruction,
                      not a local weather station measurement. Results represent
                      the nearest model grid cell at{" "}
                      {result.provenance.grid_latitude.toFixed(3)},{" "}
                      {result.provenance.grid_longitude.toFixed(3)}, not a city-
                      or country-wide average. Daily aggregation uses{" "}
                      {result.provenance.timezone}. The 1991–2020 baseline has{" "}
                      {format(result.quality.baseline_coverage_pct, 2)}%
                      coverage.
                    </p>
                    <p>
                      Data last retrieved:{" "}
                      {new Date(
                        result.provenance.fetched_at,
                      ).toLocaleDateString("en-GB")}
                      . Historical yearly records are cached for 30 days. The
                      latest complete calendar year is {maxYear}.
                    </p>
                  </details>
                  <details>
                    <summary>Trend interpretation & limitations</summary>
                    <p>
                      Frequency trend: ordinary least squares on annual event
                      counts, using years with at least 95% valid observations.
                      It is descriptive; no significance, prediction, or causal
                      attribution is claimed. The line on the chart is a
                      trailing five-year mean and is not the regression fit.{" "}
                      {result.accounting}
                    </p>
                    <ul>
                      {result.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                    <p>
                      Quality flags: {result.quality.invalid_values} invalid
                      values, {result.quality.duplicate_dates} duplicate dates,{" "}
                      {result.quality.invalid_dates} invalid dates. Event
                      durations marked * may be lower bounds.
                    </p>
                  </details>
                </section>
              </>
            )}
          </section>
        </div>
        <footer className="footer">
          <span className="brand small">
            heat<span>atlas</span>
          </span>
          <p>Historical patterns. Honest uncertainty.</p>
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
            Weather data by Open-Meteo · CC BY 4.0
          </a>
        </footer>
      </main>
    </>
  );
}

function Metric({
  label,
  value,
  suffix,
  sub,
}: {
  label: string;
  value: string;
  suffix?: string;
  sub: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <div>
        {value}
        {suffix && <small>{suffix}</small>}
      </div>
      <p>{sub}</p>
    </div>
  );
}
function ComparisonBar({
  label,
  value,
  max,
  early,
}: {
  label: string;
  value: number;
  max: number;
  early?: boolean;
}) {
  return (
    <div className="comparison-row">
      <div>
        <span>{label}</span>
        <strong>
          {format(value, 1)} <small>events/yr</small>
        </strong>
      </div>
      <div className="comparison-track">
        <i
          style={{ width: `${(value / max) * 100}%` }}
          className={early ? "early" : ""}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
