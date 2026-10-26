
export interface AnalysisRequest {
    publish_from: string;
    publish_to: string;
    settlement_from: string;
    settlement_to: string;
    decision_cutoff: string;
    delivery_start: string;
    delivery_end: string;
}

export interface ForecastComparison {
    startTime: string;
    publishTime: string;
    forecastGeneration: number;
    actualGeneration: number;
    error: number;
    absoluteError: number;
}

export interface AnalysisResponse {
    publicationWindow: { from: string; to: string };
    settlementWindow: { from: string; to: string };
    decisionCutoff: string;
    deliveryStart: string;
    deliveryEnd: string;
    matchedPeriods: number;
    mae: number | null;
    comparisons: ForecastComparison[];
}

export interface AnalysisStats {
    expectedHours: number;
    matchedHours: number;
    coveragePercent: number;
    meanForecast: number | null;
    meanActual: number | null;
    worstHours: ForecastComparison[];
}

const LOOKBACK_HOURS = 96;
const HOUR_MS = 60 * 60 * 1000;

function requireValidDate(value: string, name: string): Date {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(`${name} must be a valid date.`);
    }

    return date;
}

/** Build a UTC timestamp from a date string and HH:mm time. */
export function buildUtcTimestamp(
    date: string,
    time: string,
): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Date must use YYYY-MM-DD format.");
    }

    if (!/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(time)) {
        throw new Error("Time must be a valid hour or half-hour in UTC.");
    }

    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    const timestamp = new Date(
        Date.UTC(year, month - 1, day, hour, minute),
    );

    // Date.UTC normalizes impossible dates, so reject those explicitly.
    if (
        timestamp.getUTCFullYear() !== year ||
        timestamp.getUTCMonth() !== month - 1 ||
        timestamp.getUTCDate() !== day
    ) {
        throw new Error("Date is not a real calendar date.");
    }

    return timestamp.toISOString().replace(".000Z", "Z");
}

function utcDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/**
 * Return a date-only settlement range that includes every UTC date
 * touched by [deliveryStart, deliveryEnd).
 *
 * settlement_to is exclusive. A non-midnight delivery end therefore
 * requires the following date as the settlement upper bound.
 */
export function getSettlementRange(
    deliveryStart: string,
    deliveryEnd: string,
): { settlement_from: string; settlement_to: string } {
    const start = requireValidDate(deliveryStart, "Delivery start");
    const end = requireValidDate(deliveryEnd, "Delivery end");

    if (end <= start) {
        throw new Error("Delivery end must be after delivery start.");
    }

    const endAtUtcMidnight =
        end.getUTCHours() === 0 &&
        end.getUTCMinutes() === 0 &&
        end.getUTCSeconds() === 0 &&
        end.getUTCMilliseconds() === 0;

    const settlementEnd = new Date(end);

    if (!endAtUtcMidnight) {
        settlementEnd.setUTCDate(settlementEnd.getUTCDate() + 1);
    }

    const settlementFrom = utcDate(start);
    const settlementTo = utcDate(settlementEnd);

    // The backend requires a strictly increasing date range.
    if (settlementTo <= settlementFrom) {
        throw new Error("Invalid settlement date range.");
    }

    return {
        settlement_from: settlementFrom,
        settlement_to: settlementTo,
    };
}

/**
 * Provisional 96-hour publication lookback.
 *
 * If deliveryStart - 96h would fall after the cutoff, use the 96 hours
 * before the cutoff instead. This prevents an inverted publication
 * window. The 96-hour assumption still needs validation against Elexon.
 */
export function getPublicationWindow(
    deliveryStart: string,
    decisionCutoff: string,
): { publish_from: string; publish_to: string } {
    const start = requireValidDate(deliveryStart, "Delivery start");
    const cutoff = requireValidDate(decisionCutoff, "Decision cutoff");

    const candidate = new Date(start.getTime() - LOOKBACK_HOURS * HOUR_MS);
    const publishFrom =
        candidate.getTime() <= cutoff.getTime()
            ? candidate
            : new Date(cutoff.getTime() - LOOKBACK_HOURS * HOUR_MS);

    return {
        publish_from: publishFrom.toISOString().replace(".000Z", "Z"),
        publish_to: cutoff.toISOString().replace(".000Z", "Z"),
    };
}

export function getExpectedHours(
    deliveryStart: string,
    deliveryEnd: string,
): number {
    const start = requireValidDate(deliveryStart, "Delivery start");
    const end = requireValidDate(deliveryEnd, "Delivery end");
    const duration = end.getTime() - start.getTime();

    if (duration <= 0 || duration % HOUR_MS !== 0) {
        throw new Error(
            "Delivery window must have a positive, whole-hour duration.",
        );
    }

    if (
        start.getUTCMinutes() !== 0 ||
        start.getUTCSeconds() !== 0 ||
        start.getUTCMilliseconds() !== 0 ||
        end.getUTCMinutes() !== 0 ||
        end.getUTCSeconds() !== 0 ||
        end.getUTCMilliseconds() !== 0
    ) {
        throw new Error("Delivery boundaries must align to whole UTC hours.");
    }

    return duration / HOUR_MS;
}

export function getAnalysisStats(
    response: AnalysisResponse,
): AnalysisStats {
    const expectedHours = getExpectedHours(
        response.deliveryStart,
        response.deliveryEnd,
    );

    const rows = response.comparisons;
    const matchedHours = rows.length;

    const mean = (values: number[]): number | null =>
        values.length === 0
            ? null
            : values.reduce((sum, value) => sum + value, 0) / values.length;

    return {
        expectedHours,
        matchedHours,
        coveragePercent:
            expectedHours === 0 ? 0 : (matchedHours / expectedHours) * 100,
        meanForecast: mean(rows.map((row) => row.forecastGeneration)),
        meanActual: mean(rows.map((row) => row.actualGeneration)),
        worstHours: [...rows]
            .sort(
                (a, b) =>
                    b.absoluteError - a.absoluteError ||
                    a.startTime.localeCompare(b.startTime),
            )
            .slice(0, 5),
    };
}

/** Lead time from forecast publication to delivery, in hours. */
export function getLeadTimeHours(
    startTime: string,
    publishTime: string,
): number {
    const delivery = requireValidDate(startTime, "Delivery timestamp");
    const publication = requireValidDate(publishTime, "Publication timestamp");

    return (delivery.getTime() - publication.getTime()) / HOUR_MS;
}

/** Compare current controls with the inputs used for the last successful run. */
export function areInputsStale(
    current: AnalysisRequest,
    lastRun: AnalysisRequest | null,
): boolean {
    if (!lastRun) return false;

    return (
        (Object.keys(current) as (keyof AnalysisRequest)[]).some(
            (key) => current[key] !== lastRun[key],
        )
    );
}
