
import asyncio
import httpx

URL = (
    "https://data.elexon.co.uk/bmrs/api/v1"
    "/generation/actual/per-type"
)

START = "2026-01-11T00:00:00Z"
END = "2026-01-12T00:00:00Z"


async def main():
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            URL,
            params={
                "from": START,
                "to": END,
                "format": "json",
            },
        )

        print("Request URL:", response.url)
        print("HTTP status:", response.status_code)
        response.raise_for_status()

        payload = response.json()

    records = payload.get("data", [])

    print("\n=== AGPT Metadata ===")
    print(payload.get("metadata"))

    print("\n=== Response Summary ===")
    print("Record count:", len(records))

    if not records:
        print("No records returned.")
        return

    print("\n=== Available Fields ===")
    print(sorted(records[0].keys()))

    print("\n=== First Five Records ===")
    for record in records[:5]:
        print(record)

    print("\n=== Wind-Related Records ===")
    wind_records = [
        record
        for record in records
        if "wind" in str(record).lower()
    ]

    print("Wind-related record count:", len(wind_records))

    for record in wind_records[:10]:
        print(record)

    print("\n=== Category Values ===")
    for field in (
        "fuelType",
        "psrType",
        "businessType",
        "startTime",
    ):
        values = sorted({
            str(record[field])
            for record in records
            if record.get(field) is not None
        })

        if values:
            print(f"{field}: {values[:30]}")


if __name__ == "__main__":
    asyncio.run(main())
