
from datetime import datetime, timezone, timedelta

import httpx


BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1"


def parse_utc(value: str) -> datetime:
    """Parse an ISO 8601 timestamp and normalize it to UTC."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))

    if parsed.tzinfo is None:
        raise ValueError("Timestamp must include a timezone")

    return parsed.astimezone(timezone.utc)


async def fetch_wind_forecasts(
    publish_from: str,
    publish_to: str,
) -> list[dict]:
    """Fetch WINDFOR forecast records for the publication window."""
    url = f"{BASE_URL}/datasets/WINDFOR/stream"

    params = {
        "publishDateTimeFrom": publish_from,
        "publishDateTimeTo": publish_to,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

    if isinstance(data, dict):
        data = [data]

    if not isinstance(data, list):
        raise ValueError("Unexpected WINDFOR response format")

    return data


async def fetch_actual_wind_generation(
    start_from: str,
    start_to: str,
) -> list[dict]:
    """Fetch FUELHH actual generation records for wind."""
    url = f"{BASE_URL}/datasets/FUELHH/stream"

    params = {
        "settlementDateFrom": start_from,
        "settlementDateTo": start_to,
        "fuelType": "WIND",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

    if isinstance(data, dict):
        data = [data]

    if not isinstance(data, list):
        raise ValueError("Unexpected FUELHH response format")

    return [
        record
        for record in data
        if isinstance(record, dict)
        and record.get("fuelType") == "WIND"
    ]


def calculate_forecast_accuracy(
    forecasts: list[dict],
    actuals: list[dict],
    decision_cutoff: str,
    delivery_start: str | None = None,
    delivery_end: str | None = None,
) -> dict:
    """
    Select the latest eligible forecast per delivery timestamp
    and calculate MAE against FUELHH wind actuals.

    When a delivery window is provided, hourly forecasts are compared
    with the mean of exactly one :00 and one :30 actual reading.
    """

    cutoff = parse_utc(decision_cutoff)
    start = parse_utc(delivery_start) if delivery_start else None
    end = parse_utc(delivery_end) if delivery_end else None

    if (start is None) != (end is None):
        raise ValueError(
            "delivery_start and delivery_end must be provided together"
        )

    if start is not None and end is not None and start >= end:
        raise ValueError(
            "delivery_start must be earlier than delivery_end"
        )

    def in_delivery_window(timestamp: str) -> bool:
        target = parse_utc(timestamp)

        return (
            (start is None or target >= start)
            and (end is None or target < end)
        )

    # --------------------------------------------------
    # 1. Group eligible forecasts by delivery timestamp.
    # --------------------------------------------------

    forecasts_by_time: dict[datetime, list[tuple[datetime, dict]]] = {}

    for forecast in forecasts:
        if not isinstance(forecast, dict):
            continue

        start_time = forecast.get("startTime")
        publish_time = forecast.get("publishTime")
        generation = forecast.get("generation")

        if (
            not start_time
            or not publish_time
            or generation is None
        ):
            continue

        try:
            target_time = parse_utc(start_time)
            published_at = parse_utc(publish_time)
            generation_value = float(generation)
        except (TypeError, ValueError, OverflowError):
            continue

        if not (
            generation_value == generation_value
            and abs(generation_value) != float("inf")
        ):
            continue

        if published_at > cutoff:
            continue

        if not in_delivery_window(start_time):
            continue

        forecasts_by_time.setdefault(target_time, []).append(
            (published_at, forecast)
        )

    # Preserve eligible forecast publication history for the timeline.
    publication_timeline = []

    for target_time, candidates in forecasts_by_time.items():
        for published_at, forecast in candidates:
            publication_timeline.append({
                "startTime": target_time.isoformat(),
                "publishTime": published_at.isoformat(),
                "forecastGeneration": float(forecast["generation"]),
            })

    publication_timeline.sort(
        key=lambda item: (item["startTime"], item["publishTime"])
    )

    # Select the latest publication for each delivery timestamp.
    # If the latest publication has conflicting generation values,
    # exclude that delivery timestamp rather than choosing arbitrarily.
    conflicting_forecast_hours = 0
    latest_forecast_by_time = {}

    for target_time, candidates in forecasts_by_time.items():
        latest_published_at = max(
            published_at for published_at, _ in candidates
        )

        latest_candidates = [
            forecast
            for published_at, forecast in candidates
            if published_at == latest_published_at
        ]

        try:
            generations = {
                float(forecast["generation"])
                for forecast in latest_candidates
            }
        except (TypeError, ValueError, OverflowError):
            continue

        if len(generations) == 1:
            latest_forecast_by_time[target_time] = latest_candidates[0]
        else:
            conflicting_forecast_hours += 1

    # --------------------------------------------------
    # 2. Collect valid FUELHH actual readings by timestamp.
    # --------------------------------------------------

    actual_values_by_time: dict[datetime, list[float]] = {}

    for record in actuals:
        if not isinstance(record, dict):
            continue

        start_time = record.get("startTime")
        generation = record.get("generation")

        if (
            not start_time
            or record.get("fuelType") != "WIND"
            or generation is None
        ):
            continue

        try:
            target_time = parse_utc(start_time)
            generation_value = float(generation)
        except (TypeError, ValueError, OverflowError):
            continue

        if not (
            generation_value == generation_value
            and abs(generation_value) != float("inf")
        ):
            continue

        if not in_delivery_window(start_time):
            continue

        if start is not None and end is not None:
            # Hourly aggregation only accepts exact half-hour boundaries.
            if (
                target_time.minute not in (0, 30)
                or target_time.second != 0
                or target_time.microsecond != 0
            ):
                continue

        actual_values_by_time.setdefault(target_time, []).append(
            generation_value
        )

    # --------------------------------------------------
    # 3. Aggregate half-hour actuals into complete hourly values.
    # --------------------------------------------------

    incomplete_actual_hours = 0
    ambiguous_actual_hours = 0

    if start is not None and end is not None:
        actual_by_time = {}

        expected_hour_count = int((end - start).total_seconds() // 3600)
        expected_hours = [
            start + timedelta(hours=i)
            for i in range(expected_hour_count)
        ]

        for hour in expected_hours:
            first_values = actual_values_by_time.get(hour, [])
            second_values = actual_values_by_time.get(
                hour.replace(minute=30), []
            )

            # Diagnostics count issues per expected hour; an hour can be both
            # incomplete and ambiguous when one boundary is duplicated and
            # the other is absent.
            if not first_values or not second_values:
                incomplete_actual_hours += 1

            if len(first_values) > 1 or len(second_values) > 1:
                ambiguous_actual_hours += 1

        hours = {
            timestamp.replace(minute=0, second=0, microsecond=0)
            for timestamp in actual_values_by_time
        }

        for hour in hours:
            first_half = hour
            second_half = hour.replace(minute=30)

            first_values = actual_values_by_time.get(first_half, [])
            second_values = actual_values_by_time.get(second_half, [])

            # Each expected timestamp must occur exactly once.
            if len(first_values) == 1 and len(second_values) == 1:
                actual_by_time[hour] = (
                    first_values[0] + second_values[0]
                ) / 2
    else:
        # Without a delivery window, preserve exact-timestamp matching.
        # Ambiguous duplicate actual timestamps are excluded.
        actual_by_time = {
            timestamp: values[0]
            for timestamp, values in actual_values_by_time.items()
            if len(values) == 1
        }

    # --------------------------------------------------
    # 4. Match forecasts with actuals and calculate errors.
    # --------------------------------------------------

    comparisons = []

    for target_time, forecast in latest_forecast_by_time.items():
        if target_time not in actual_by_time:
            continue

        forecast_generation = float(forecast["generation"])
        actual_generation = actual_by_time[target_time]
        error = forecast_generation - actual_generation

        comparisons.append({
            "startTime": target_time.isoformat(),
            "publishTime": forecast["publishTime"],
            "forecastGeneration": forecast_generation,
            "actualGeneration": actual_generation,
            "error": error,
            "absoluteError": abs(error),
        })

    comparisons.sort(key=lambda item: item["startTime"])

    if not comparisons:
        return {
            "decisionCutoff": decision_cutoff,
            "deliveryStart": delivery_start,
            "deliveryEnd": delivery_end,
            "matchedPeriods": 0,
            "expectedHours": expected_hour_count if start is not None else None,
            "missingForecastHours": (
                max(0, expected_hour_count - len(latest_forecast_by_time))
                if start is not None else None
            ),
            "incompleteActualHours": (
                incomplete_actual_hours if start is not None else None
            ),
            "ambiguousActualHours": (
                ambiguous_actual_hours if start is not None else None
            ),
            "conflictingForecastHours": (
                conflicting_forecast_hours if start is not None else None
            ),
            "mae": None,
            "rmse": None,
            "comparisons": [],
            "publicationTimeline": publication_timeline,
        }

    mae = sum(
        item["absoluteError"] for item in comparisons
    ) / len(comparisons)

    rmse = (
        sum(item["error"] ** 2 for item in comparisons)
        / len(comparisons)
    ) ** 0.5

    return {
        "decisionCutoff": decision_cutoff,
        "deliveryStart": delivery_start,
        "deliveryEnd": delivery_end,
        "matchedPeriods": len(comparisons),
        "expectedHours": expected_hour_count if start is not None else None,
        "missingForecastHours": (
            max(0, expected_hour_count - len(latest_forecast_by_time))
            if start is not None else None
        ),
        "incompleteActualHours": (
            incomplete_actual_hours if start is not None else None
        ),
        "ambiguousActualHours": (
            ambiguous_actual_hours if start is not None else None
        ),
        "conflictingForecastHours": (
            conflicting_forecast_hours if start is not None else None
        ),
        "mae": round(mae, 2),
        "rmse": round(rmse, 2),
        "comparisons": comparisons,
        "publicationTimeline": publication_timeline,
    }
