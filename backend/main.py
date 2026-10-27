from typing import Optional
from datetime import date
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field


from services.elexon import (
    fetch_wind_forecasts,
    fetch_actual_wind_generation,
    calculate_forecast_accuracy,
    parse_utc,
)

app = FastAPI(
    title="Wind Forecast Analysis",
    description=(
        "Assess UK wind generation forecasts "
        "for day-ahead electricity procurement."
    ),
    version="0.1.0",
)


class ComparisonResponse(BaseModel):
    startTime: str
    publishTime: str
    forecastGeneration: float
    actualGeneration: float
    error: float
    absoluteError: float

class PublicationTimelineResponse(BaseModel):
    startTime: str
    publishTime: str
    forecastGeneration: float


class WindowResponse(BaseModel):
    from_: str = Field(alias="from")
    to: str

class ForecastAccuracyResponse(BaseModel):
    publicationWindow: WindowResponse
    settlementWindow: WindowResponse
    decisionCutoff: str
    deliveryStart: str
    deliveryEnd: str
    matchedPeriods: int
    expectedHours: Optional[int]
    missingForecastHours: Optional[int]
    incompleteActualHours: Optional[int]
    ambiguousActualHours: Optional[int]
    conflictingForecastHours: Optional[int]
    mae: Optional[float]
    rmse: Optional[float]
    comparisons: list[ComparisonResponse]
    publicationTimeline: list[PublicationTimelineResponse]


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/forecasts/wind")
async def get_wind_forecasts(
    publish_from: str = Query(
        ...,
        description="Forecast publication start time in ISO 8601 format",
    ),
    publish_to: str = Query(
        ...,
        description="Forecast publication end time in ISO 8601 format",
    ),
):
    try:
        records = await fetch_wind_forecasts(publish_from, publish_to)
        return {"count": len(records), "data": records}
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="Failed to retrieve wind forecasts from the upstream data source",
        ) from exc


@app.get("/api/actuals/wind")
async def get_actual_wind_generation(
    settlement_from: str = Query(
        ...,
        description="Start settlement date in YYYY-MM-DD format",
    ),
    settlement_to: str = Query(
        ...,
        description="End settlement date in YYYY-MM-DD format",
    ),
):
    try:
        records = await fetch_actual_wind_generation(
            settlement_from, settlement_to
        )
        return {"count": len(records), "data": records}
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="Failed to retrieve actual wind generation from the upstream data source",
        ) from exc


@app.get(
    "/api/analysis/forecast-accuracy",
    response_model=ForecastAccuracyResponse,
    responses={
        400: {"description": "Invalid date, timestamp, or delivery window"},
        502: {"description": "Upstream data source or processing error"},
    },
)
async def get_forecast_accuracy(
    publish_from: str = Query(...),
    publish_to: str = Query(...),
    settlement_from: str = Query(...),
    settlement_to: str = Query(...),
    decision_cutoff: str = Query(
        ...,
        description="Latest forecast publication time allowed, in ISO 8601 format",
    ),
    delivery_start: str = Query(
        ...,
        description="Start of delivery window in ISO 8601 format",
    ),
    delivery_end: str = Query(
        ...,
        description="End of delivery window, exclusive, in ISO 8601 format",
    ),
):
    
    # Validate all user-provided date and timestamp parameters
    # before making any upstream requests.
    try:
        publication_start = parse_utc(publish_from)
        publication_end = parse_utc(publish_to)

        cutoff = parse_utc(decision_cutoff)
        start = parse_utc(delivery_start)
        end = parse_utc(delivery_end)

        settlement_start_date = date.fromisoformat(settlement_from)
        settlement_end_date = date.fromisoformat(settlement_to)

        # Require the exact YYYY-MM-DD format.
        if settlement_start_date.isoformat() != settlement_from:
            raise ValueError("settlement_from must use YYYY-MM-DD format")

        if settlement_end_date.isoformat() != settlement_to:
            raise ValueError("settlement_to must use YYYY-MM-DD format")

    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid date or timestamp parameter: {exc}",
        ) from exc

    if publication_start >= publication_end:
        raise HTTPException(
            status_code=400,
            detail="publish_from must be earlier than publish_to",
        )

    if settlement_start_date >= settlement_end_date:
        raise HTTPException(
            status_code=400,
            detail="settlement_from must be earlier than settlement_to",
        )

    if start >= end:
        raise HTTPException(
            status_code=400,
            detail="delivery_start must be earlier than delivery_end",
        )

    # Failures after validation belong to the upstream/data-processing path.
    try:
        forecasts = await fetch_wind_forecasts(
            publish_from, publish_to
        )
        actuals = await fetch_actual_wind_generation(
            settlement_from, settlement_to
        )

        result = calculate_forecast_accuracy(
            forecasts,
            actuals,
            cutoff.isoformat(),
            delivery_start=start.isoformat(),
            delivery_end=end.isoformat(),
        )

        return {
            "publicationWindow": {
                "from": publish_from,
                "to": publish_to,
            },
            "settlementWindow": {
                "from": settlement_from,
                "to": settlement_to,
            },
            **result,
        }

    except Exception as exc:
        # Avoid exposing upstream exception details in the public response.
        raise HTTPException(
            status_code=502,
            detail="Forecast analysis failed due to an upstream or processing error",
        ) from exc
