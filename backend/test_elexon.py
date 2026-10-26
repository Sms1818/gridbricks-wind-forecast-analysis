
import asyncio
from collections import Counter
from datetime import timedelta

from services.elexon import (
    fetch_actual_wind_generation,
    fetch_wind_forecasts,
    parse_utc,
)


# --------------------------------------------------
# 1. Test configuration
# --------------------------------------------------

DECISION_CUTOFF = "2026-01-10T10:00:00Z"

DELIVERY_START = "2026-01-11T00:00:00Z"
DELIVERY_END = "2026-01-12T00:00:00Z"

PUBLISH_FROM = "2026-01-10T00:00:00Z"
PUBLISH_TO = "2026-01-11T00:00:00Z"

SETTLEMENT_FROM = "2026-01-11"
SETTLEMENT_TO = "2026-01-12"


async def main():
    # --------------------------------------------------
    # 2. Parse timestamps
    # --------------------------------------------------

    cutoff = parse_utc(DECISION_CUTOFF)
    delivery_start = parse_utc(DELIVERY_START)
    delivery_end = parse_utc(DELIVERY_END)

    if delivery_start >= delivery_end:
        raise ValueError(
            "DELIVERY_START must be earlier than DELIVERY_END"
        )

    expected_hours = int(
        (delivery_end - delivery_start).total_seconds() / 3600
    )

    print("=" * 65)
    print("WIND FORECAST ACCURACY VALIDATION")
    print("=" * 65)

    print(f"Decision cutoff: {cutoff.isoformat()}")
    print(f"Delivery start:  {delivery_start.isoformat()}")
    print(f"Delivery end:    {delivery_end.isoformat()}")
    print(f"Expected hours:  {expected_hours}")

    # --------------------------------------------------
    # 3. Fetch Elexon data
    # --------------------------------------------------

    print("\nFetching wind forecasts...")

    forecasts = await fetch_wind_forecasts(
        PUBLISH_FROM,
        PUBLISH_TO,
    )

    print(f"Forecast records fetched: {len(forecasts)}")

    print("\nFetching actual wind generation...")

    actuals = await fetch_actual_wind_generation(
        SETTLEMENT_FROM,
        SETTLEMENT_TO,
    )

    print(f"Actual records fetched: {len(actuals)}")

    print("\n=== Raw Forecast Sample ===")
    for row in forecasts[:3]:
        print(row)

    print("\n=== Raw Actual Sample ===")
    for row in actuals[:3]:
        print(row)

    print("\n=== Actual Record Fields ===")
    if actuals:
        print(sorted(actuals[0].keys()))

    print("\n=== Forecast Record Fields ===")
    if forecasts:
        print(sorted(forecasts[0].keys()))

    # --------------------------------------------------
    # 4. Filter data by cutoff and delivery window
    # --------------------------------------------------

    eligible_forecasts = [
        row
        for row in forecasts
        if row.get("publishTime")
        and row.get("startTime")
        and row.get("generation") is not None
        and parse_utc(row["publishTime"]) <= cutoff
        and delivery_start
        <= parse_utc(row["startTime"])
        < delivery_end
    ]

    eligible_actuals = [
        row
        for row in actuals
        if row.get("startTime")
        and row.get("generation") is not None
        and row.get("fuelType") == "WIND"
        and delivery_start
        <= parse_utc(row["startTime"])
        < delivery_end
    ]

    print("\n=== Data Coverage ===")
    print(f"Eligible forecast records: {len(eligible_forecasts)}")
    print(f"Eligible actual records:   {len(eligible_actuals)}")

    publication_counts = Counter(
        row["publishTime"]
        for row in eligible_forecasts
    )

    print("\nForecast publication times:")

    for publish_time, count in sorted(publication_counts.items()):
        print(f"  {publish_time}: {count} records")

    # --------------------------------------------------
    # 5. Select the latest eligible forecast per hour
    # --------------------------------------------------

    latest_forecast_by_hour = {}

    for row in eligible_forecasts:
        hour = parse_utc(row["startTime"])
        publish_time = parse_utc(row["publishTime"])

        existing = latest_forecast_by_hour.get(hour)

        if (
            existing is None
            or publish_time > parse_utc(existing["publishTime"])
        ):
            latest_forecast_by_hour[hour] = row

    print(
        "\nSelected forecast hours: "
        f"{len(latest_forecast_by_hour)}"
    )

    # --------------------------------------------------
    # 6. Aggregate half-hourly actuals into hourly values
    # --------------------------------------------------

    actual_values_by_hour = {}

    for row in eligible_actuals:
        start_time = parse_utc(row["startTime"])

        hour = start_time.replace(
            minute=0,
            second=0,
            microsecond=0,
        )

        actual_values_by_hour.setdefault(hour, []).append(
            float(row["generation"])
        )

    hourly_actuals = {}

    for hour, values in actual_values_by_hour.items():
        # Only accept hours with both half-hourly readings.
        if len(values) == 2:
            hourly_actuals[hour] = sum(values) / len(values)

    print(f"Complete hourly actuals: {len(hourly_actuals)}")

    # --------------------------------------------------
    # 7. Match forecasts against actuals
    # --------------------------------------------------

    comparisons = []

    for hour in sorted(latest_forecast_by_hour):
        forecast_row = latest_forecast_by_hour[hour]

        if hour not in hourly_actuals:
            continue

        forecast_mw = float(forecast_row["generation"])
        actual_mw = hourly_actuals[hour]

        error_mw = forecast_mw - actual_mw

        comparisons.append(
            {
                "startTime": hour.isoformat(),
                "publishTime": forecast_row["publishTime"],
                "forecastMW": forecast_mw,
                "actualMW": actual_mw,
                "errorMW": error_mw,
                "absoluteErrorMW": abs(error_mw),
            }
        )

    print("\n=== Accuracy Results ===")
    print(f"Matched periods: {len(comparisons)}")

    if comparisons:
        mae = sum(
            item["absoluteErrorMW"]
            for item in comparisons
        ) / len(comparisons)

        print(f"Mean Absolute Error (MAE): {mae:.2f} MW")

        print("\nFirst five comparisons:")

        for item in comparisons[:5]:
            print(item)

        # --------------------------------------------------
        # 7.1 Forecast bias diagnostics
        # --------------------------------------------------

        forecasts_mw = [
            row["forecastMW"]
            for row in comparisons
        ]

        actuals_mw = [
            row["actualMW"]
            for row in comparisons
        ]

        errors_mw = [
            row["errorMW"]
            for row in comparisons
        ]

        overforecast_hours = sum(
            error > 0 for error in errors_mw
        )

        underforecast_hours = sum(
            error < 0 for error in errors_mw
        )

        equal_forecast_hours = sum(
            error == 0 for error in errors_mw
        )

        mean_forecast = sum(forecasts_mw) / len(forecasts_mw)
        mean_actual = sum(actuals_mw) / len(actuals_mw)
        mean_signed_error = sum(errors_mw) / len(errors_mw)

        print("\n" + "=" * 65)
        print("FORECAST BIAS DIAGNOSTICS")
        print("=" * 65)

        print(f"Average forecast:       {mean_forecast:.2f} MW")
        print(f"Average actual:         {mean_actual:.2f} MW")
        print(f"Mean signed error:      {mean_signed_error:.2f} MW")
        print(f"Forecast above actual:  {overforecast_hours} hours")
        print(f"Forecast below actual:  {underforecast_hours} hours")
        print(f"Forecast equals actual: {equal_forecast_hours} hours")

        print(
            "\nInterpretation: a positive mean signed error means "
            "the selected forecasts were higher than actual "
            "generation on average. A negative value means they "
            "were lower."
        )

        # --------------------------------------------------
        # 7.2 Hourly comparison table
        # --------------------------------------------------

        print("\n=== Hourly Comparison ===")
        print(
            f"{'Hour (UTC)':<22}"
            f"{'Forecast MW':>14}"
            f"{'Actual MW':>14}"
            f"{'Error MW':>14}"
        )

        print("-" * 64)

        for item in comparisons:
            print(
                f"{item['startTime']:<22}"
                f"{item['forecastMW']:>14.2f}"
                f"{item['actualMW']:>14.2f}"
                f"{item['errorMW']:>14.2f}"
            )

    else:
        print("No matching forecast and actual periods were found.")

    # --------------------------------------------------
    # 8. Validation checks
    # --------------------------------------------------

    print("\n" + "=" * 65)
    print("VALIDATION CHECKS")
    print("=" * 65)

    forecasts_after_cutoff = [
        row
        for row in latest_forecast_by_hour.values()
        if parse_utc(row["publishTime"]) > cutoff
    ]

    print(
        "No selected forecast published after cutoff: "
        f"{len(forecasts_after_cutoff) == 0}"
    )

    print(
        "Selected forecast hours match expected delivery hours: "
        f"{len(latest_forecast_by_hour) == expected_hours}"
    )

    print(
        "Complete actual hours match expected delivery hours: "
        f"{len(hourly_actuals) == expected_hours}"
    )

    print(
        "Matched periods match expected delivery hours: "
        f"{len(comparisons) == expected_hours}"
    )

    missing_forecast_hours = sorted(
        hour
        for hour in (
            delivery_start + timedelta(hours=i)
            for i in range(expected_hours)
        )
        if hour not in latest_forecast_by_hour
    )

    missing_actual_hours = sorted(
        hour
        for hour in (
            delivery_start + timedelta(hours=i)
            for i in range(expected_hours)
        )
        if hour not in hourly_actuals
    )

    if missing_forecast_hours:
        print("\nMissing forecast hours:")

        for hour in missing_forecast_hours:
            print(f"  {hour.isoformat()}")

    if missing_actual_hours:
        print("\nMissing complete actual hours:")

        for hour in missing_actual_hours:
            print(f"  {hour.isoformat()}")

    print("\nValidation complete.")


if __name__ == "__main__":
    asyncio.run(main())
