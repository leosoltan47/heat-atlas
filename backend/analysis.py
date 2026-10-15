"""Pure heatwave analysis. No network, database or UI dependencies."""
from __future__ import annotations

from calendar import isleap
from datetime import date, timedelta
import math
from statistics import mean

BASELINE_START = 1991
BASELINE_END = 2020
MIN_COVERAGE = 0.95
MIN_RUN = 3


def quantile(values: list[float], probability: float) -> float:
    """Linear interpolation (Hyndman/Fan type 7, like NumPy's default)."""
    if not values:
        raise ValueError("Cannot estimate a percentile without observations")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    fraction = position - lower
    return ordered[lower] + fraction * (ordered[min(lower + 1, len(ordered) - 1)] - ordered[lower])


def normalize_days(rows: list[dict], start: date, end: date) -> tuple[list[dict], dict]:
    """Reject bad dates/units upstream; drop impossible values and fill gaps with null.

    Conflicting duplicate dates are invalidated rather than arbitrarily taking a value.
    Missing/invalid days are never interpolated, since that could invent a heatwave.
    """
    seen: dict[date, float | None] = {}
    issues = {"invalid_values": 0, "duplicate_dates": 0, "invalid_dates": 0}
    for row in rows:
        try:
            day = date.fromisoformat(row["date"])
        except (ValueError, TypeError, KeyError):
            issues["invalid_dates"] += 1
            continue
        if not start <= day <= end:
            continue
        value = row.get("tmax")
        if value is not None and (isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not -90 <= value <= 60):
            issues["invalid_values"] += 1
            value = None
        if day in seen:
            issues["duplicate_dates"] += 1
            if seen[day] != value:
                seen[day] = None
        else:
            seen[day] = float(value) if value is not None else None
    result = []
    current = start
    while current <= end:
        result.append({"date": current.isoformat(), "tmax": seen.get(current)})
        current += timedelta(days=1)
    return result, issues


def detect_events(days: list[dict], threshold: float) -> list[dict]:
    """Find >=3 consecutive calendar days strictly above the fixed threshold.

    Runs are found before splitting into years, avoiding New Year's boundary errors.
    Input must contain one sorted row per calendar day (normalize_days guarantees it).
    """
    events: list[dict] = []
    run: list[dict] = []
    run_start_index = 0

    def finish(next_index: int) -> None:
        if len(run) < MIN_RUN:
            return
        start_index = run_start_index
        left_unknown = start_index == 0 or days[start_index - 1]["tmax"] is None
        right_unknown = next_index == len(days) or days[next_index]["tmax"] is None
        values = [r["tmax"] for r in run]
        events.append({
            "start": run[0]["date"], "end": run[-1]["date"],
            "duration": len(run), "peak_c": round(max(values), 2),
            "mean_excess_c": round(mean(values) - threshold, 3),
            "censored": left_unknown or right_unknown,
            "days": [r["date"] for r in run],
        })

    for index, row in enumerate(days):
        value = row["tmax"]
        if value is not None and value > threshold:
            if not run:
                run_start_index = index
            run.append(row)
        else:
            finish(index)
            run = []
    finish(len(days))
    return events


def linear_trend(points: list[tuple[int, float]]) -> dict | None:
    if len(points) < 5:
        return None
    x_mean = mean(x for x, _ in points)
    y_mean = mean(y for _, y in points)
    denominator = sum((x - x_mean) ** 2 for x, _ in points)
    slope = sum((x - x_mean) * (y - y_mean) for x, y in points) / denominator
    intercept = y_mean - slope * x_mean
    residual = sum((y - (intercept + slope * x)) ** 2 for x, y in points)
    total = sum((y - y_mean) ** 2 for _, y in points)
    return {"slope_per_decade": round(slope * 10, 4), "intercept": intercept,
            "slope_per_year": slope, "r_squared": round(1 - residual / total, 4) if total > 0 else None,
            "years_used": len(points), "method": "ordinary least squares; descriptive, not an attribution or significance test"}


def analyze(rows: list[dict], start_year: int, end_year: int) -> dict:
    fetch_start = min(start_year, BASELINE_START)
    fetch_end = max(end_year, BASELINE_END)
    days, issues = normalize_days(rows, date(fetch_start, 1, 1), date(fetch_end, 12, 31))
    baseline = [r["tmax"] for r in days if BASELINE_START <= int(r["date"][:4]) <= BASELINE_END and r["tmax"] is not None]
    baseline_expected = sum(366 if isleap(y) else 365 for y in range(BASELINE_START, BASELINE_END + 1))
    baseline_coverage = len(baseline) / baseline_expected
    baseline_year_coverage = []
    for year in range(BASELINE_START, BASELINE_END + 1):
        count = sum(r["tmax"] is not None for r in days if r["date"].startswith(str(year)))
        baseline_year_coverage.append(count / (366 if isleap(year) else 365))
    if baseline_coverage < MIN_COVERAGE or any(c < 0.90 for c in baseline_year_coverage):
        raise ValueError("The fixed 1991–2020 baseline has insufficient valid data (requires 95% overall and 90% per year).")
    threshold = quantile(baseline, 0.95)
    events = detect_events(days, threshold)
    selected_start = date(start_year, 1, 1).isoformat()
    selected_end = date(end_year, 12, 31).isoformat()
    selected_events = [e for e in events if selected_start <= e["start"] <= selected_end]
    heat_days = {d for event in events for d in event["days"]}
    yearly = []
    for year in range(start_year, end_year + 1):
        year_days = [r for r in days if r["date"].startswith(str(year))]
        valid = [r for r in year_days if r["tmax"] is not None]
        covered = [r for r in valid if r["date"] in heat_days]
        year_events = [e for e in selected_events if e["start"].startswith(str(year))]
        coverage = len(valid) / len(year_days)
        yearly.append({
            "year": year, "events": len(year_events), "heatwave_days": len(covered),
            "longest_event_days": max((e["duration"] for e in year_events), default=0),
            "mean_excess_c": round(mean(r["tmax"] - threshold for r in covered), 3) if covered else None,
            "peak_c": round(max((r["tmax"] for r in covered), default=0), 2) if covered else None,
            "valid_days": len(valid), "missing_days": len(year_days) - len(valid),
            "coverage_pct": round(coverage * 100, 2), "included_in_trend": coverage >= MIN_COVERAGE,
        })
    points = [(r["year"], r["events"]) for r in yearly if r["included_in_trend"]]
    trend = linear_trend(points)
    for i, row in enumerate(yearly):
        window = yearly[max(0, i - 4): i + 1]
        row["rolling_events"] = round(mean(r["events"] for r in window), 3) if len(window) == 5 and all(r["included_in_trend"] for r in window) else None
        row["trend_events"] = max(0, trend["intercept"] + trend["slope_per_year"] * row["year"]) if trend else None
    first_window, last_window = yearly[:5], yearly[-5:]
    comparison = None
    if len(yearly) >= 10 and all(r["included_in_trend"] for r in first_window + last_window):
        early = mean(r["events"] for r in first_window)
        recent = mean(r["events"] for r in last_window)
        comparison = {"early_mean": round(early, 3), "recent_mean": round(recent, 3),
                      "absolute_change": round(recent - early, 3),
                      "percent_change": round((recent - early) / early * 100, 1) if early > 0 else None,
                      "early_years": f"{first_window[0]['year']}–{first_window[-1]['year']}",
                      "recent_years": f"{last_window[0]['year']}–{last_window[-1]['year']}"}
    selected_days = [r for r in days if selected_start <= r["date"] <= selected_end]
    warnings = []
    excluded = [r["year"] for r in yearly if not r["included_in_trend"]]
    if excluded:
        warnings.append(f"Years with <95% valid days are excluded from trends: {', '.join(map(str, excluded))}. Their counts may underestimate heatwaves.")
    censored = sum(e["censored"] for e in selected_events)
    if censored:
        warnings.append(f"{censored} event(s) touch a data gap or the available record boundary; their duration is a lower bound.")
    if trend is None:
        warnings.append("At least five sufficiently complete years are required for a descriptive trend.")
    if comparison is None:
        warnings.append("A first/last five-year comparison needs at least ten years and complete comparison windows.")
    warnings.append("This fixed, all-season threshold is a transparent study definition, not a local health warning or causal attribution of climate change.")
    return {
        "period": {"start_year": start_year, "end_year": end_year},
        "definition": {"minimum_consecutive_days": MIN_RUN, "strictly_above": True, "percentile": 95,
                       "threshold_c": round(threshold, 3), "baseline_start": BASELINE_START, "baseline_end": BASELINE_END,
                       "threshold_scope": "fixed percentile of all valid daily maxima in the 1991–2020 baseline"},
        "yearly": yearly, "events": [{k: v for k, v in e.items() if k != "days"} for e in selected_events],
        "trend": trend, "comparison": comparison,
        "summary": {"total_events": len(selected_events), "total_heatwave_days": sum(r["heatwave_days"] for r in yearly),
                    "longest_event_days": max((e["duration"] for e in selected_events), default=0),
                    "peak_c": max((r["peak_c"] for r in yearly if r["peak_c"] is not None), default=None)},
        "quality": {"valid_days": sum(r["tmax"] is not None for r in selected_days),
                    "expected_days": len(selected_days), "baseline_coverage_pct": round(baseline_coverage * 100, 3),
                    "excluded_years": excluded, "censored_events": censored, **issues},
        "warnings": warnings,
        "accounting": "Events belong to the year they start; heatwave days belong to their calendar year. Events already in progress at the start of the selected period can contribute days but not a new event.",
    }
