
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

export interface ForecastPublication {
    startTime: string;
    publishTime: string;
    forecastGeneration: number;
}

export interface AnalysisResponse {
    publicationWindow: { from: string; to: string };
    settlementWindow: { from: string; to: string };
    decisionCutoff: string;
    deliveryStart: string;
    deliveryEnd: string;
    matchedPeriods: number;
    expectedHours: number;
    missingForecastHours: number;
    incompleteActualHours: number;
    ambiguousActualHours: number;
    conflictingForecastHours: number;
    mae: number | null;
    rmse: number | null;
    comparisons: ForecastComparison[];
    publicationTimeline?: ForecastPublication[];
}

export interface AnalysisStats {
    expectedHours: number;
    matchedHours: number;
    unmatchedHours: number;
    coveragePercent: number;
    meanForecast: number | null;
    meanActual: number | null;
    meanSignedError: number | null;
    worstHours: ForecastComparison[];
}

export interface HourlyObservation {
    startTime: string;
    forecastGeneration: number | null;
    actualGeneration: number | null;
    error: number | null;
    absoluteError: number | null;
    publishTime: string | null;
    leadTimeHours: number | null;
    matched: boolean;
}

/**
 * WINDFOR is fetched by publication time. NESO wind forecasts are produced
 * on a multi-day horizon and republished frequently. A 7-day lookback
 * covers the longest delivery window the UI allows, so the latest eligible
 * publication at cutoff is not dropped by a shorter fetch window.
 */
export const PUBLICATION_LOOKBACK_HOURS = 168;
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
 * Publication fetch window ending at the decision cutoff.
 *
 * Look back from delivery start when that still precedes the cutoff.
 * If delivery is more than PUBLICATION_LOOKBACK_HOURS after the cutoff,
 * look back from the cutoff instead so the range cannot invert.
 */
export function getPublicationWindow(
    deliveryStart: string,
    decisionCutoff: string,
): { publish_from: string; publish_to: string } {
    const start = requireValidDate(deliveryStart, "Delivery start");
    const cutoff = requireValidDate(decisionCutoff, "Decision cutoff");

    const candidate = new Date(
        start.getTime() - PUBLICATION_LOOKBACK_HOURS * HOUR_MS,
    );
    const publishFrom =
        candidate.getTime() <= cutoff.getTime()
            ? candidate
            : new Date(
                cutoff.getTime() - PUBLICATION_LOOKBACK_HOURS * HOUR_MS,
            );

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

    // All averages use matched pairs only; an absent hour is never treated
    // as zero generation or zero forecast error.
    const rows = response.comparisons;
    const matchedHours = rows.length;

    const mean = (values: number[]): number | null =>
        values.length === 0
            ? null
            : values.reduce((sum, value) => sum + value, 0) / values.length;

    return {
        expectedHours,
        matchedHours,
        unmatchedHours: expectedHours - matchedHours,
        coveragePercent:
            expectedHours === 0 ? 0 : (matchedHours / expectedHours) * 100,
        meanForecast: mean(rows.map((row) => row.forecastGeneration)),
        meanActual: mean(rows.map((row) => row.actualGeneration)),
        meanSignedError: mean(rows.map((row) => row.error)),
        worstHours: [...rows]
            .sort(
                (a, b) =>
                    b.absoluteError - a.absoluteError ||
                    a.startTime.localeCompare(b.startTime),
            )
            .slice(0, 5),
    };
}

function toHourIso(timestamp: number): string {
    return new Date(timestamp).toISOString().replace(".000Z", "Z");
}

/**
 * One row per expected delivery hour. Unmatched hours have null forecast
 * and actual values; the analysis response does not identify which source
 * caused the gap.
 */
export function getHourlyObservations(
    deliveryStart: string,
    deliveryEnd: string,
    comparisons: ForecastComparison[],
): HourlyObservation[] {
    const expectedHours = getExpectedHours(deliveryStart, deliveryEnd);
    const start = requireValidDate(deliveryStart, "Delivery start").getTime();
    // Build from the requested window so gaps remain visible even though the
    // API returns comparison rows only for hours with both sources available.
    const matchedByHour = new Map(
        comparisons.map((row) => [Date.parse(row.startTime), row]),
    );

    const observations: HourlyObservation[] = [];

    for (let index = 0; index < expectedHours; index += 1) {
        const timestamp = start + index * HOUR_MS;
        const startTime = toHourIso(timestamp);
        const row = matchedByHour.get(timestamp);

        if (!row) {
            observations.push({
                startTime,
                forecastGeneration: null,
                actualGeneration: null,
                error: null,
                absoluteError: null,
                publishTime: null,
                leadTimeHours: null,
                matched: false,
            });
            continue;
        }

        observations.push({
            startTime: row.startTime,
            forecastGeneration: row.forecastGeneration,
            actualGeneration: row.actualGeneration,
            error: row.error,
            absoluteError: row.absoluteError,
            publishTime: row.publishTime,
            leadTimeHours: getLeadTimeHours(row.startTime, row.publishTime),
            matched: true,
        });
    }

    return observations;
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
