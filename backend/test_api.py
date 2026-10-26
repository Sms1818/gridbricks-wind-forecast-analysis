from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

import main


client = TestClient(main.app)


def valid_params():
    return {
        "publish_from": "2026-01-10T00:00:00Z",
        "publish_to": "2026-01-14T09:00:00Z",
        "settlement_from": "2026-01-14",
        "settlement_to": "2026-01-15",
        "decision_cutoff": "2026-01-14T09:00:00Z",
        "delivery_start": "2026-01-14T00:00:00Z",
        "delivery_end": "2026-01-15T00:00:00Z",
    }


def test_analysis_endpoint_returns_expected_response_shape(monkeypatch):
    forecasts = [
        {
            "startTime": "2026-01-14T00:00:00Z",
            "publishTime": "2026-01-14T08:00:00Z",
            "generation": 120,
        }
    ]

    actuals = [
        {
            "startTime": "2026-01-14T00:00:00Z",
            "fuelType": "WIND",
            "generation": 80,
        },
        {
            "startTime": "2026-01-14T00:30:00Z",
            "fuelType": "WIND",
            "generation": 120,
        },
    ]

    mock_forecasts = AsyncMock(return_value=forecasts)
    mock_actuals = AsyncMock(return_value=actuals)

    monkeypatch.setattr(main, "fetch_wind_forecasts", mock_forecasts)
    monkeypatch.setattr(
        main,
        "fetch_actual_wind_generation",
        mock_actuals,
    )

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=valid_params(),
    )

    assert response.status_code == 200

    body = response.json()

    assert body["publicationWindow"] == {
        "from": "2026-01-10T00:00:00Z",
        "to": "2026-01-14T09:00:00Z",
    }

    assert body["settlementWindow"] == {
        "from": "2026-01-14",
        "to": "2026-01-15",
    }

    assert body["matchedPeriods"] == 1
    assert body["mae"] == 20
    assert len(body["comparisons"]) == 1

    comparison = body["comparisons"][0]

    assert comparison["forecastGeneration"] == 120
    assert comparison["actualGeneration"] == 100
    assert comparison["error"] == 20
    assert comparison["absoluteError"] == 20

    mock_forecasts.assert_awaited_once_with(
        "2026-01-10T00:00:00Z",
        "2026-01-14T09:00:00Z",
    )

    mock_actuals.assert_awaited_once_with(
        "2026-01-14",
        "2026-01-15",
    )


def test_analysis_endpoint_rejects_reversed_delivery_window(
    monkeypatch,
):
    mock_forecasts = AsyncMock(return_value=[])
    mock_actuals = AsyncMock(return_value=[])

    monkeypatch.setattr(main, "fetch_wind_forecasts", mock_forecasts)
    monkeypatch.setattr(
        main,
        "fetch_actual_wind_generation",
        mock_actuals,
    )

    params = valid_params()
    params["delivery_start"] = "2026-01-15T00:00:00Z"
    params["delivery_end"] = "2026-01-14T00:00:00Z"

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=params,
    )

    assert response.status_code == 400

    mock_forecasts.assert_not_awaited()
    mock_actuals.assert_not_awaited()


def test_analysis_endpoint_returns_502_when_upstream_fetch_fails(
    monkeypatch,
):
    mock_forecasts = AsyncMock(
        side_effect=RuntimeError("Upstream unavailable"),
    )
    mock_actuals = AsyncMock(return_value=[])

    monkeypatch.setattr(main, "fetch_wind_forecasts", mock_forecasts)
    monkeypatch.setattr(
        main,
        "fetch_actual_wind_generation",
        mock_actuals,
    )

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=valid_params(),
    )

    assert response.status_code == 502
    assert "Forecast analysis failed" in response.json()["detail"]
