import httpx
import pytest
from fastapi.testclient import TestClient

import main


client = TestClient(main.app)


def make_http_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request(
        "GET",
        "https://data.elexon.co.uk/bmrs/api/v1/datasets/WINDFOR/stream",
    )
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(
        f"Upstream returned {status_code}",
        request=request,
        response=response,
    )


def valid_analysis_params():
    return {
        "publish_from": "2026-01-10T00:00:00Z",
        "publish_to": "2026-01-11T00:00:00Z",
        "settlement_from": "2026-01-11",
        "settlement_to": "2026-01-12",
        "decision_cutoff": "2026-01-10T10:00:00Z",
        "delivery_start": "2026-01-11T00:00:00Z",
        "delivery_end": "2026-01-12T00:00:00Z",
    }


def test_forecast_endpoint_returns_502_on_upstream_http_error(monkeypatch):
    async def mock_fetch(*args, **kwargs):
        raise make_http_error(503)

    monkeypatch.setattr(main, "fetch_wind_forecasts", mock_fetch)

    response = client.get(
        "/api/forecasts/wind",
        params={
            "publish_from": "2026-01-10T00:00:00Z",
            "publish_to": "2026-01-11T00:00:00Z",
        },
    )

    assert response.status_code == 502
    assert "Failed to retrieve wind forecasts" in response.json()["detail"]


def test_forecast_endpoint_returns_502_on_upstream_timeout(monkeypatch):
    async def mock_fetch(*args, **kwargs):
        raise httpx.TimeoutException("Upstream request timed out")

    monkeypatch.setattr(main, "fetch_wind_forecasts", mock_fetch)

    response = client.get(
        "/api/forecasts/wind",
        params={
            "publish_from": "2026-01-10T00:00:00Z",
            "publish_to": "2026-01-11T00:00:00Z",
        },
    )

    assert response.status_code == 502
    assert "Failed to retrieve wind forecasts" in response.json()["detail"]


def test_forecast_endpoint_returns_502_on_unexpected_response_format(
    monkeypatch,
):
    async def mock_fetch(*args, **kwargs):
        raise ValueError("Unexpected WINDFOR response format")

    monkeypatch.setattr(main, "fetch_wind_forecasts", mock_fetch)

    response = client.get(
        "/api/forecasts/wind",
        params={
            "publish_from": "2026-01-10T00:00:00Z",
            "publish_to": "2026-01-11T00:00:00Z",
        },
    )

    assert response.status_code == 502
    assert "Failed to retrieve wind forecasts" in response.json()["detail"]


def test_analysis_returns_502_on_upstream_http_error(monkeypatch):
    async def mock_fetch_forecasts(*args, **kwargs):
        raise make_http_error(503)

    monkeypatch.setattr(
        main, "fetch_wind_forecasts", mock_fetch_forecasts
    )

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=valid_analysis_params(),
    )

    assert response.status_code == 502
    assert "Forecast analysis failed" in response.json()["detail"]


def test_analysis_returns_502_on_upstream_timeout(monkeypatch):
    async def mock_fetch_forecasts(*args, **kwargs):
        raise httpx.TimeoutException("Upstream request timed out")

    monkeypatch.setattr(
        main, "fetch_wind_forecasts", mock_fetch_forecasts
    )

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=valid_analysis_params(),
    )

    assert response.status_code == 502
    assert "Forecast analysis failed" in response.json()["detail"]


def test_analysis_returns_502_on_unexpected_upstream_format(monkeypatch):
    async def mock_fetch_forecasts(*args, **kwargs):
        raise ValueError("Unexpected WINDFOR response format")

    monkeypatch.setattr(
        main, "fetch_wind_forecasts", mock_fetch_forecasts
    )

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=valid_analysis_params(),
    )

    assert response.status_code == 502


@pytest.mark.parametrize(
    ("parameter", "value"),
    [
        ("publish_from", "not-a-timestamp"),
        ("publish_to", "2026-99-99T00:00:00Z"),
    ],
)
def test_analysis_rejects_invalid_publication_timestamps(
    monkeypatch, parameter, value
):
    async def unexpected_fetch(*args, **kwargs):
        raise AssertionError(
            "Elexon should not be called for invalid input"
        )

    monkeypatch.setattr(main, "fetch_wind_forecasts", unexpected_fetch)
    monkeypatch.setattr(
        main, "fetch_actual_wind_generation", unexpected_fetch
    )

    params = valid_analysis_params()
    params[parameter] = value

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=params,
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    ("parameter", "value"),
    [
        ("settlement_from", "not-a-date"),
        ("settlement_to", "2026-99-99"),
    ],
)
def test_analysis_rejects_invalid_settlement_dates(
    monkeypatch, parameter, value
):
    async def unexpected_fetch(*args, **kwargs):
        raise AssertionError(
            "Elexon should not be called for invalid input"
        )

    monkeypatch.setattr(main, "fetch_wind_forecasts", unexpected_fetch)
    monkeypatch.setattr(
        main, "fetch_actual_wind_generation", unexpected_fetch
    )

    params = valid_analysis_params()
    params[parameter] = value

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=params,
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    ("parameter", "value"),
    [
        ("publish_from", "2026-01-12T00:00:00Z"),
        ("settlement_from", "2026-01-12"),
        ("settlement_to", "2026-01-11"),
    ],
)
def test_analysis_rejects_reversed_or_equal_ranges(
    monkeypatch, parameter, value
):
    async def unexpected_fetch(*args, **kwargs):
        raise AssertionError(
            "Elexon should not be called for invalid ranges"
        )

    monkeypatch.setattr(main, "fetch_wind_forecasts", unexpected_fetch)
    monkeypatch.setattr(
        main, "fetch_actual_wind_generation", unexpected_fetch
    )

    params = valid_analysis_params()
    params[parameter] = value

    response = client.get(
        "/api/analysis/forecast-accuracy",
        params=params,
    )

    assert response.status_code == 400
