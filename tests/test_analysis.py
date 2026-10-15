from datetime import date, timedelta
import math
import pytest
from backend.analysis import analyze, detect_events, linear_trend, normalize_days, quantile


def daily(start, values):
    day = date.fromisoformat(start)
    return [{"date": (day + timedelta(days=i)).isoformat(), "tmax": value} for i, value in enumerate(values)]


def baseline():
    # Synthetic fixtures are used only in tests, never as application fallback data.
    first, last = date(1991, 1, 1), date(2020, 12, 31)
    return daily(first.isoformat(), [20.0] * ((last - first).days + 1))


def test_percentile_interpolation():
    assert quantile([0, 10], .95) == pytest.approx(9.5)


def test_threshold_is_strict_and_requires_three_days():
    assert detect_events(daily("2021-01-01", [31, 31, 30, 31, 31]), 30) == []
    event = detect_events(daily("2021-01-01", [20, 31, 32, 33, 20]), 30)[0]
    assert (event["duration"], event["peak_c"], event["mean_excess_c"], event["censored"]) == (3, 33, 2, False)


def test_missing_day_breaks_run_and_marks_lower_bound():
    assert detect_events(daily("2021-01-01", [31, 31, None, 31, 31]), 30) == []
    assert detect_events(daily("2021-01-01", [None, 31, 31, 31, 20]), 30)[0]["censored"]


def test_normalization_fills_calendar_and_rejects_corrupt_values():
    rows = [{"date": "2020-02-28", "tmax": 30}, {"date": "2020-03-01", "tmax": math.inf},
            {"date": "bad", "tmax": 20}, {"date": "2020-02-28", "tmax": 31}]
    result, issues = normalize_days(rows, date(2020, 2, 28), date(2020, 3, 1))
    assert len(result) == 3
    assert all(row["tmax"] is None for row in result)
    assert issues == {"invalid_values": 1, "duplicate_dates": 1, "invalid_dates": 1}


def test_cross_year_event_counted_once_days_split():
    rows = baseline() + daily("2021-01-01", [20.0] * 365) + daily("2022-01-01", [20.0] * 365)
    hot = {"2021-12-30", "2021-12-31", "2022-01-01", "2022-01-02"}
    for row in rows:
        if row["date"] in hot:
            row["tmax"] = 35
    result = analyze(rows, 2021, 2022)
    assert result["summary"]["total_events"] == 1
    assert [r["heatwave_days"] for r in result["yearly"]] == [2, 2]
    assert [r["events"] for r in result["yearly"]] == [1, 0]
    assert result["events"][0]["duration"] == 4


def test_baseline_rejected_when_a_year_is_missing():
    with pytest.raises(ValueError, match="baseline"):
        analyze([r for r in baseline() if not r["date"].startswith("2000")], 1991, 2020)


def test_zero_baseline_counts_do_not_invent_percentage():
    result = analyze(baseline(), 1991, 2020)
    assert result["comparison"]["percent_change"] is None
    assert result["summary"]["total_events"] == 0
    assert result["trend"]["slope_per_decade"] == 0
    assert result["yearly"][3]["rolling_events"] is None
    assert result["yearly"][4]["rolling_events"] == 0


def test_low_coverage_year_excluded_from_trend():
    rows = baseline() + daily("2021-01-01", [None] * 30 + [20.] * 335)
    result = analyze(rows, 2016, 2021)
    assert result["quality"]["excluded_years"] == [2021]
    assert result["trend"]["years_used"] == 5
    assert result["yearly"][-1]["rolling_events"] is None


def test_known_linear_trend():
    result = linear_trend([(2000 + i, 2 * i + 1) for i in range(10)])
    assert result["slope_per_decade"] == 20
    assert result["r_squared"] == 1
    assert linear_trend([(2000, 1)]) is None
