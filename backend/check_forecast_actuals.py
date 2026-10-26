
import asyncio
from collections import defaultdict

import httpx

from services.elexon import (
    fetch_actual_wind_generation,
    fetch_wind_forecasts,
    parse_utc,
)


# --------------------------------------------------
# 1. Fixed test scenario
# --------------------------------------------------

DECISION_CUTOFF = "2026-01-10T10:00:00Z"

DELIVERY_START = "2026-01-11T00:00:00Z"
DELIVERY_END = "2026-01-12T00:00:00Z"

PUBLISH_FROM = "2026-01-10T00:00:00Z"
PUBLISH_TO = "2026-01-11T00:00:00Z"

SETTLEMENT_FROM = "2026-01-11"
SETTLEMENT_TO = "2026-01-12"

AGPT_URL = (
    "https://data.elexon.co.uk/bmrs/api/v1"
    "/generation/actual/per-type"
)


async def main():
    cutoff = parse_utc(DECISION_CUTOFF)
    delivery_start = parse_utc(DELIVERY_START)
    delivery_end = parse_utc(DELIVERY_END)

    print("=" * 75)
    print("WINDFOR FORECAST VS ACTUAL GENERATION")
    print("=" * 75)
    print(f"Decision cutoff: {cutoff.isoformat()}")
    print(f"Delivery window: {delivery_start.isoformat()} to {delivery_end.isoformat()}")

    # --------------------------------------------------
    # 2. Fetch forecasts
    # --------------------------------------------------

    print("\nFetching WINDFOR forecasts...")

    forecasts = await fetch_wind_forecasts(
        PUBLISH_FROM,
        PUBLISH_TO,
    )

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

    # Keep the latest eligible forecast for each delivery hour.
    forecast_by_hour = {}

    for row in eligible_forecasts:
        hour = parse_utc(row["startTime"])
        existing = forecast_by_hour.get(hour)

        if (
            existing is None
            or parse_utc(row["publishTime"])
            > parse_utc(existing["publishTime"])
        ):
            forecast_by_hour[hour] = row

    print("Forecast records fetched:", len(forecasts))
    print("Eligible forecast records:", len(eligible_forecasts))
    print("Selected forecast hours:", len(forecast_by_hour))

    selected_publications = sorted({
        row["publishTime"]
        for row in forecast_by_hour.values()
    })

    print("Selected publication times:", selected_publications)

    # --------------------------------------------------
    # 3. Fetch AGPT actual generation
    # --------------------------------------------------

    print("\nFetching AGPT actual generation...")

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            AGPT_URL,
            params={
                "from": DELIVERY_START,
                "to": DELIVERY_END,
                "format": "json",
            },
        )
        response.raise_for_status()
        agpt_payload = response.json()

    agpt_records = agpt_payload.get("data", [])

    # Each AGPT record contains nested generation categories.
    # Sum wind onshore + offshore for each half-hour timestamp.
    agpt_by_half_hour = {}

    for record in agpt_records:
        if not record.get("startTime"):
            continue

        timestamp = parse_utc(record["startTime"])

        if not delivery_start <= timestamp < delivery_end:
            continue

        wind_total = 0.0
        found_wind = False

        for item in record.get("data", []):
            if (
                item.get("businessType") == "Wind generation"
                and item.get("psrType")
                in ("Wind Onshore", "Wind Offshore")
                and item.get("quantity") is not None
            ):
                wind_total += float(item["quantity"])
                found_wind = True

        if found_wind:
            agpt_by_half_hour[timestamp] = wind_total

    # Average two half-hourly AGPT values into one hourly value.
    agpt_values_by_hour = defaultdict(list)

    for timestamp, value in agpt_by_half_hour.items():
        hour = timestamp.replace(
            minute=0,
            second=0,
            microsecond=0,
        )
        agpt_values_by_hour[hour].append(value)

    agpt_by_hour = {
        hour: sum(values) / 2
        for hour, values in agpt_values_by_hour.items()
        if len(values) == 2
    }

    print("AGPT records returned:", len(agpt_records))
    print("AGPT half-hour wind values:", len(agpt_by_half_hour))
    print("Complete AGPT hourly values:", len(agpt_by_hour))

    # --------------------------------------------------
    # 4. Fetch FUELHH actual generation
    # --------------------------------------------------

    print("\nFetching FUELHH actual generation...")

    fuelhh_records = await fetch_actual_wind_generation(
        SETTLEMENT_FROM,
        SETTLEMENT_TO,
    )

    fuelhh_values_by_hour = defaultdict(list)

    for row in fuelhh_records:
        if (
            row.get("fuelType") != "WIND"
            or row.get("generation") is None
            or not row.get("startTime")
        ):
            continue

        timestamp = parse_utc(row["startTime"])

        if not delivery_start <= timestamp < delivery_end:
            continue

        hour = timestamp.replace(
            minute=0,
            second=0,
            microsecond=0,
        )

        fuelhh_values_by_hour[hour].append(
            float(row["generation"])
        )

    fuelhh_by_hour = {
        hour: sum(values) / 2
        for hour, values in fuelhh_values_by_hour.items()
        if len(values) == 2
    }

    print("FUELHH records returned:", len(fuelhh_records))
    print("Complete FUELHH hourly values:", len(fuelhh_by_hour))

    # --------------------------------------------------
    # 5. Compare the same forecasts against both sources
    # --------------------------------------------------

    comparisons = []

    for hour in sorted(forecast_by_hour):
        if hour not in agpt_by_hour or hour not in fuelhh_by_hour:
            continue

        forecast_row = forecast_by_hour[hour]
        forecast_mw = float(forecast_row["generation"])
        agpt_mw = agpt_by_hour[hour]
        fuelhh_mw = fuelhh_by_hour[hour]

        comparisons.append({
            "hour": hour,
            "publishTime": forecast_row["publishTime"],
            "forecastMW": forecast_mw,
            "agptMW": agpt_mw,
            "fuelhhMW": fuelhh_mw,
            "agptError": forecast_mw - agpt_mw,
            "fuelhhError": forecast_mw - fuelhh_mw,
        })

    print("\n" + "=" * 75)
    print("HOURLY COMPARISON")
    print("=" * 75)

    print(
        f"{'Hour UTC':<23}"
        f"{'Forecast MW':>13}"
        f"{'AGPT MW':>13}"
        f"{'FUELHH MW':>13}"
        f"{'AGPT Error':>13}"
        f"{'FUELHH Error':>15}"
    )
    print("-" * 90)

    for item in comparisons:
        print(
            f"{item['hour'].isoformat():<23}"
            f"{item['forecastMW']:>13.2f}"
            f"{item['agptMW']:>13.2f}"
            f"{item['fuelhhMW']:>13.2f}"
            f"{item['agptError']:>13.2f}"
            f"{item['fuelhhError']:>15.2f}"
        )

    # --------------------------------------------------
    # 6. Calculate metrics
    # --------------------------------------------------

    print("\n" + "=" * 75)
    print("FINAL METRICS")
    print("=" * 75)

    print("Matched hours:", len(comparisons))

    if not comparisons:
        print("No matched hours. Cannot calculate MAE.")
        return

    agpt_mae = sum(
        abs(item["agptError"])
        for item in comparisons
    ) / len(comparisons)

    fuelhh_mae = sum(
        abs(item["fuelhhError"])
        for item in comparisons
    ) / len(comparisons)

    agpt_bias = sum(
        item["agptError"]
        for item in comparisons
    ) / len(comparisons)

    fuelhh_bias = sum(
        item["fuelhhError"]
        for item in comparisons
    ) / len(comparisons)

    print(f"MAE against AGPT:   {agpt_mae:.2f} MW")
    print(f"MAE against FUELHH: {fuelhh_mae:.2f} MW")
    print(f"Mean error against AGPT:   {agpt_bias:.2f} MW")
    print(f"Mean error against FUELHH: {fuelhh_bias:.2f} MW")

    print("\nCoverage checks:")
    print("Expected delivery hours: 24")
    print("Selected forecasts:", len(forecast_by_hour))
    print("AGPT complete hours:", len(agpt_by_hour))
    print("FUELHH complete hours:", len(fuelhh_by_hour))
    print("Matched hours:", len(comparisons))

    if len(comparisons) != 24:
        print(
            "\nWARNING: The comparison does not cover all 24 hours. "
            "Inspect missing forecast or actual periods before drawing conclusions."
        )


if __name__ == "__main__":
    asyncio.run(main())
