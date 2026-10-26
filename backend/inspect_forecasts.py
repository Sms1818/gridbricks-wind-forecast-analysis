
import asyncio
from collections import Counter

from services.elexon import fetch_wind_forecasts


async def main():
    records = await fetch_wind_forecasts(
        "2026-01-10T00:00:00Z",
        "2026-01-11T00:00:00Z",
    )

    publish_times = Counter(
        record["publishTime"] for record in records
    )
    target_times = Counter(
        record["startTime"] for record in records
    )

    print("Total records:", len(records))
    print("Unique publication times:", len(publish_times))
    print("Unique target times:", len(target_times))

    print("\nMost common publication times:")
    for time, count in publish_times.most_common(10):
        print(time, "->", count, "records")

    print("\nTarget times with multiple forecast records:")
    for time, count in target_times.items():
        if count > 1:
            print(time, "->", count, "forecasts")


if __name__ == "__main__":
    asyncio.run(main())
