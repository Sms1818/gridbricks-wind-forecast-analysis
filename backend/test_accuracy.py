
import pytest

from services.elexon import calculate_forecast_accuracy


CUTOFF = "2026-01-10T10:00:00Z"


@pytest.fixture
def forecasts():
    return [
        {
            "startTime": "2026-01-10T10:00:00Z",
            "publishTime": "2026-01-10T07:30:00Z",
            "generation": 12000,
        },
        {
            "startTime": "2026-01-10T10:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 11500,
        },
        {
            "startTime": "2026-01-10T10:00:00Z",
            "publishTime": "2026-01-10T10:30:00Z",
            "generation": 10000,
        },
        {
            "startTime": "2026-01-10T10:30:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 15000,
        },
    ]


@pytest.fixture
def actuals():
    return [
        {
            "startTime": "2026-01-10T10:00:00Z",
            "fuelType": "WIND",
            "generation": 11000,
        },
        {
            "startTime": "2026-01-10T10:30:00Z",
            "fuelType": "WIND",
            "generation": 16000,
        },
    ]


def test_selects_latest_forecast_available_at_cutoff(forecasts, actuals):
    result = calculate_forecast_accuracy(forecasts, actuals, CUTOFF)

    first = result["comparisons"][0]

    assert first["forecastGeneration"] == 11500
    assert first["publishTime"] == "2026-01-10T09:30:00Z"


def test_excludes_forecasts_published_after_cutoff(forecasts, actuals):
    result = calculate_forecast_accuracy(forecasts, actuals, CUTOFF)

    selected_publications = [
        item["publishTime"] for item in result["comparisons"]
    ]

    assert "2026-01-10T10:30:00Z" not in selected_publications


def test_calculates_mae_correctly(forecasts, actuals):
    result = calculate_forecast_accuracy(forecasts, actuals, CUTOFF)

    # Absolute errors: |11500 - 11000| = 500
    #                  |15000 - 16000| = 1000
    # MAE = (500 + 1000) / 2 = 750
    assert result["matchedPeriods"] == 2
    assert result["mae"] == 750


def test_returns_decision_cutoff(forecasts, actuals):
    result = calculate_forecast_accuracy(forecasts, actuals, CUTOFF)

    assert result["decisionCutoff"] == CUTOFF


def test_ignores_non_wind_actuals(forecasts):
    actuals = [
        {
            "startTime": "2026-01-10T10:00:00Z",
            "fuelType": "SOLAR",
            "generation": 11000,
        }
    ]

    result = calculate_forecast_accuracy(forecasts, actuals, CUTOFF)

    assert result["matchedPeriods"] == 0
    assert result["mae"] is None
    assert result["comparisons"] == []


def test_ignores_actuals_with_missing_generation(forecasts):
    actuals = [
        {
            "startTime": "2026-01-10T10:00:00Z",
            "fuelType": "WIND",
            "generation": None,
        }
    ]

    result = calculate_forecast_accuracy(forecasts, actuals, CUTOFF)

    assert result["matchedPeriods"] == 0
    assert result["mae"] is None


def test_returns_empty_result_when_nothing_matches():
    result = calculate_forecast_accuracy([], [], CUTOFF)

    assert result["matchedPeriods"] == 0
    assert result["mae"] is None
    assert result["comparisons"] == []
    assert result["decisionCutoff"] == CUTOFF


def test_aggregates_two_half_hour_actuals_into_hourly_average():
    forecasts = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 100,
        }
    ]

    actuals = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 80,
        },
        {
            "startTime": "2026-01-11T00:30:00Z",
            "fuelType": "WIND",
            "generation": 100,
        },
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        CUTOFF,
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    assert result["matchedPeriods"] == 1
    assert result["comparisons"][0]["actualGeneration"] == 90
    assert result["comparisons"][0]["absoluteError"] == 10
    assert result["mae"] == 10


def test_excludes_incomplete_hour_of_actuals():
    forecasts = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 100,
        }
    ]

    actuals = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 80,
        }
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        CUTOFF,
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    assert result["matchedPeriods"] == 0
    assert result["mae"] is None


def test_excludes_forecasts_outside_delivery_window():
    forecasts = [
        {
            "startTime": "2026-01-10T23:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 100,
        },
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 100,
        },
    ]

    actuals = [
        {
            "startTime": "2026-01-10T23:00:00Z",
            "fuelType": "WIND",
            "generation": 90,
        },
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 80,
        },
        {
            "startTime": "2026-01-11T00:30:00Z",
            "fuelType": "WIND",
            "generation": 100,
        },
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        CUTOFF,
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    assert result["matchedPeriods"] == 1
    assert result["comparisons"][0]["startTime"] == (
        "2026-01-11T00:00:00+00:00"
    )
    assert result["comparisons"][0]["actualGeneration"] == 90


def test_rejects_invalid_delivery_window():
    with pytest.raises(ValueError):
        calculate_forecast_accuracy(
            [],
            [],
            CUTOFF,
            delivery_start="2026-01-12T00:00:00Z",
            delivery_end="2026-01-11T00:00:00Z",
        )


def test_does_not_count_duplicate_half_hour_readings_as_a_complete_hour():
    forecasts = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 100,
        }
    ]

    # Two records exist, but both refer to 00:00.
    # The 00:30 reading is missing.
    actuals = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 80,
        },
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 120,
        },
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        CUTOFF,
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    assert result["matchedPeriods"] == 0
    assert result["mae"] is None


def test_does_not_count_unexpected_timestamps_as_a_complete_hour():
    forecasts = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 100,
        }
    ]

    # Two readings are present, but neither is at the expected
    # half-hour boundaries of 00:00 and 00:30.
    actuals = [
        {
            "startTime": "2026-01-11T00:15:00Z",
            "fuelType": "WIND",
            "generation": 80,
        },
        {
            "startTime": "2026-01-11T00:45:00Z",
            "fuelType": "WIND",
            "generation": 120,
        },
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        CUTOFF,
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    assert result["matchedPeriods"] == 0
    assert result["mae"] is None


def test_includes_forecast_published_exactly_at_cutoff():
    forecasts = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": CUTOFF,
            "generation": 120,
        }
    ]

    actuals = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 100,
        },
        {
            "startTime": "2026-01-11T00:30:00Z",
            "fuelType": "WIND",
            "generation": 100,
        },
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        CUTOFF,
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    assert result["matchedPeriods"] == 1
    assert result["comparisons"][0]["forecastGeneration"] == 120
    assert result["mae"] == 20


def test_duplicate_forecast_publication_is_not_selected_arbitrarily():
    forecasts = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 120,
        },
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 140,
        },
    ]

    actuals = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 100,
        },
        {
            "startTime": "2026-01-11T00:30:00Z",
            "fuelType": "WIND",
            "generation": 100,
        },
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        CUTOFF,
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    # Until we define a valid source-level tie-break rule,
    # ambiguous duplicate forecasts should not be silently chosen.
    assert result["matchedPeriods"] == 0
    assert result["mae"] is None


def test_excludes_delivery_hour_when_both_actual_readings_are_missing():
    forecasts = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 100,
        },
        {
            "startTime": "2026-01-11T01:00:00Z",
            "publishTime": "2026-01-10T09:30:00Z",
            "generation": 120,
        },
    ]

    actuals = [
        {
            "startTime": "2026-01-11T00:00:00Z",
            "fuelType": "WIND",
            "generation": 80,
        },
        {
            "startTime": "2026-01-11T00:30:00Z",
            "fuelType": "WIND",
            "generation": 100,
        },
        # No actual readings exist for the 01:00 hour.
    ]

    result = calculate_forecast_accuracy(
        forecasts,
        actuals,
        "2026-01-10T10:00:00Z",
        delivery_start="2026-01-11T00:00:00Z",
        delivery_end="2026-01-12T00:00:00Z",
    )

    assert result["matchedPeriods"] == 1
    assert result["comparisons"][0]["startTime"] == (
        "2026-01-11T00:00:00+00:00"
    )
    assert result["mae"] == 10
