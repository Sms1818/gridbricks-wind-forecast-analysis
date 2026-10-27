import type {
    AnalysisRequest,
    AnalysisResponse,
    ForecastComparison,
} from "../domain/analysis";

export class AnalysisApiError extends Error {
    public readonly kind: "validation" | "upstream" | "network" | "unknown";
    public readonly status?: number;

    constructor(
        message: string,
        kind: "validation" | "upstream" | "network" | "unknown",
        status?: number,
    ) {
        super(message);

        this.name = "AnalysisApiError";
        this.kind = kind;
        this.status = status;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }

    const timestamp = Date.parse(value);

    return Number.isFinite(timestamp) ? timestamp : null;
}

function isValidComparison(value: unknown): value is ForecastComparison {
    if (!isRecord(value)) {
        return false;
    }

    const startTime = parseTimestamp(value.startTime);
    const publishTime = parseTimestamp(value.publishTime);

    return (
        startTime !== null &&
        publishTime !== null &&
        isFiniteNumber(value.forecastGeneration) &&
        isFiniteNumber(value.actualGeneration) &&
        isFiniteNumber(value.error) &&
        isFiniteNumber(value.absoluteError)
    );
}

function isValidPublication(value: unknown): boolean {
    if (!isRecord(value)) return false;

    return (
        parseTimestamp(value.startTime) !== null &&
        parseTimestamp(value.publishTime) !== null &&
        isFiniteNumber(value.forecastGeneration)
    );
}

function isValidWindow(value: unknown): value is {
    from: string;
    to: string;
} {
    if (!isRecord(value)) {
        return false;
    }

    const from = parseTimestamp(value.from);
    const to = parseTimestamp(value.to);

    return (
        typeof value.from === "string" &&
        typeof value.to === "string" &&
        from !== null &&
        to !== null &&
        from <= to
    );
}

function isAnalysisResponse(value: unknown): value is AnalysisResponse {
    if (!isRecord(value)) {
        return false;
    }

    return (
        isValidWindow(value.publicationWindow) &&
        isValidWindow(value.settlementWindow) &&
        parseTimestamp(value.decisionCutoff) !== null &&
        parseTimestamp(value.deliveryStart) !== null &&
        parseTimestamp(value.deliveryEnd) !== null &&
        Number.isInteger(value.matchedPeriods) &&
        typeof value.matchedPeriods === "number" &&
        value.matchedPeriods >= 0 &&
        [
            value.expectedHours,
            value.missingForecastHours,
            value.incompleteActualHours,
            value.ambiguousActualHours,
            value.conflictingForecastHours,
        ].every(
            (count) =>
                typeof count === "number" &&
                Number.isInteger(count) &&
                count >= 0,
        ) &&
        (value.mae === null ||
            (isFiniteNumber(value.mae) && value.mae >= 0)) &&
        (value.rmse === null ||
            (isFiniteNumber(value.rmse) && value.rmse >= 0)) &&
        Array.isArray(value.comparisons) &&
        value.comparisons.every(isValidComparison) &&
        (value.publicationTimeline === undefined ||
            (Array.isArray(value.publicationTimeline) &&
                value.publicationTimeline.every(isValidPublication)))
    );
}

function validateAnalysisResponse(
    data: AnalysisResponse,
    request: AnalysisRequest,
): void {
    const deliveryStart = parseTimestamp(data.deliveryStart)!;
    const deliveryEnd = parseTimestamp(data.deliveryEnd)!;
    const decisionCutoff = parseTimestamp(data.decisionCutoff)!;
    const publicationFrom = parseTimestamp(data.publicationWindow.from)!;
    const publicationTo = parseTimestamp(data.publicationWindow.to)!;

    if (deliveryStart >= deliveryEnd) {
        throw new Error("The response contains an invalid delivery window.");
    }

    if (data.matchedPeriods !== data.comparisons.length) {
        throw new Error(
            "The matched-period count does not agree with the comparison rows.",
        );
    }

    const durationHours =
        (deliveryEnd - deliveryStart) / (60 * 60 * 1000);

    if (
        !Number.isInteger(durationHours) ||
        data.expectedHours !== durationHours ||
        data.missingForecastHours > data.expectedHours ||
        data.incompleteActualHours > data.expectedHours ||
        data.ambiguousActualHours > data.expectedHours ||
        data.conflictingForecastHours > data.expectedHours
    ) {
        throw new Error(
            "The data-quality diagnostics are inconsistent with the delivery window.",
        );
    }

    if (
        data.matchedPeriods === 0
            ? data.mae !== null || data.rmse !== null
            : data.mae === null || data.rmse === null
    ) {
        throw new Error(
            "The reported MAE/RMSE is inconsistent with the matched-period count.",
        );
    }

    if (
        data.publicationWindow.from !== request.publish_from ||
        data.publicationWindow.to !== request.publish_to
    ) {
        throw new Error(
            "The returned publication window does not match the requested window.",
        );
    }

    if (
        data.settlementWindow.from !== request.settlement_from ||
        data.settlementWindow.to !== request.settlement_to
    ) {
        throw new Error(
            "The returned settlement window does not match the requested window.",
        );
    }

    if (decisionCutoff !== parseTimestamp(request.decision_cutoff)) {
        throw new Error(
            "The returned decision cutoff does not match the requested cutoff.",
        );
    }

    if (deliveryStart !== parseTimestamp(request.delivery_start) ||
        deliveryEnd !== parseTimestamp(request.delivery_end)) {
        throw new Error(
            "The returned delivery window does not match the requested window.",
        );
    }

    for (const publication of data.publicationTimeline ?? []) {
        const startTime = parseTimestamp(publication.startTime)!;
        const publishTime = parseTimestamp(publication.publishTime)!;

        if (startTime < deliveryStart || startTime >= deliveryEnd) {
            throw new Error("A timeline record falls outside the delivery window.");
        }
        if (publishTime > decisionCutoff) {
            throw new Error("A timeline publication falls outside the decision cutoff.");
        }
        if (publishTime < publicationFrom || publishTime > publicationTo) {
            throw new Error("A timeline publication falls outside the publication window.");
        }
    }

    const seenDeliveryHours = new Set<number>();
    let sumAbsoluteError = 0;
    let sumSquaredError = 0;

    for (const comparison of data.comparisons) {
        const startTime = parseTimestamp(comparison.startTime)!;
        const publishTime = parseTimestamp(comparison.publishTime)!;

        if (startTime < deliveryStart || startTime >= deliveryEnd) {
            throw new Error(
                "A comparison row falls outside the requested delivery window.",
            );
        }

        if (startTime % (60 * 60 * 1000) !== 0) {
            throw new Error(
                "A comparison row has a delivery timestamp that is not on an hour boundary.",
            );
        }

        if (publishTime > decisionCutoff) {
            throw new Error(
                "A forecast was published after the decision cutoff.",
            );
        }

        if (publishTime < publicationFrom || publishTime > publicationTo) {
            throw new Error(
                "A forecast publication falls outside the returned publication window.",
            );
        }

        if (seenDeliveryHours.has(startTime)) {
            throw new Error(
                "The response contains duplicate delivery hours.",
            );
        }

        seenDeliveryHours.add(startTime);

        const expectedError =
            comparison.forecastGeneration - comparison.actualGeneration;

        const tolerance = 0.01;

        if (Math.abs(comparison.error - expectedError) > tolerance) {
            throw new Error(
                "A comparison row has an inconsistent signed forecast error.",
            );
        }

        if (
            Math.abs(
                comparison.absoluteError - Math.abs(comparison.error),
            ) > tolerance
        ) {
            throw new Error(
                "A comparison row has an inconsistent absolute forecast error.",
            );
        }

        sumAbsoluteError += comparison.absoluteError;
        sumSquaredError += comparison.error ** 2;
    }

    if (data.mae !== null) {
        const calculatedMae = sumAbsoluteError / data.matchedPeriods;

        if (Math.abs(data.mae - calculatedMae) > 0.01) {
            throw new Error(
                "The reported MAE does not agree with the comparison rows.",
            );
        }
    }

    if (data.rmse !== null) {
        const calculatedRmse = Math.sqrt(
            sumSquaredError / data.matchedPeriods,
        );

        if (Math.abs(data.rmse - calculatedRmse) > 0.01) {
            throw new Error(
                "The reported RMSE does not agree with the comparison rows.",
            );
        }
    }
}

export async function runAnalysis(
    request: AnalysisRequest,
    signal?: AbortSignal,
): Promise<AnalysisResponse> {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(request)) {
        params.set(key, value);
    }

    let response: Response;

    try {
        response = await fetch(
            `/api/analysis/forecast-accuracy?${params}`,
            {
                method: "GET",
                headers: { Accept: "application/json" },
                signal,
            },
        );
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw error;
        }

        throw new AnalysisApiError(
            "Could not reach the analysis service.",
            "network",
        );
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => "");

        if (response.status === 400) {
            throw new AnalysisApiError(
                detail || "The analysis request was rejected.",
                "validation",
                response.status,
            );
        }

        if (response.status === 502) {
            throw new AnalysisApiError(
                "Forecast analysis failed upstream.",
                "upstream",
                response.status,
            );
        }

        throw new AnalysisApiError(
            `Analysis request failed (HTTP ${response.status}).`,
            "unknown",
            response.status,
        );
    }

    let data: unknown;

    try {
        data = await response.json();
    } catch {
        throw new AnalysisApiError(
            "The analysis service returned invalid JSON.",
            "unknown",
            response.status,
        );
    }

    if (!isAnalysisResponse(data)) {
        throw new AnalysisApiError(
            "The analysis service returned an unexpected response shape.",
            "unknown",
            response.status,
        );
    }

    try {
        validateAnalysisResponse(data, request);
    } catch (error) {
        const detail =
            error instanceof Error
                ? error.message
                : "The response failed data validation.";

        throw new AnalysisApiError(
            `The analysis service returned inconsistent data: ${detail}`,
            "unknown",
            response.status,
        );
    }

    return data;
}
