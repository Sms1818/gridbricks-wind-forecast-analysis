
import { describe, expect, it } from "vitest";
import {
    PUBLICATION_LOOKBACK_HOURS,
    areInputsStale,
    buildUtcTimestamp,
    getAnalysisStats,
    getExpectedHours,
    getHourlyObservations,
    getLeadTimeHours,
    getPublicationWindow,
    getSettlementRange,
    type AnalysisRequest,
    type AnalysisResponse,
} from "./analysis";

describe("buildUtcTimestamp", () => {
    it("builds an explicit UTC timestamp", () => {
        expect(buildUtcTimestamp("2026-01-14", "09:30")).toBe(
            "2026-01-14T09:30:00Z",
        );
    });

    it("rejects impossible dates", () => {
        expect(() => buildUtcTimestamp("2026-02-30", "09:00")).toThrow();
    });

    it("rejects unsupported time increments", () => {
        expect(() => buildUtcTimestamp("2026-01-14", "09:15")).toThrow();
    });
});

describe("getSettlementRange", () => {
    it.each([
        ["2026-01-14T06:00:00Z", "2026-01-14T18:00:00Z", "2026-01-14", "2026-01-15"],
        ["2026-01-14T00:00:00Z", "2026-01-15T00:00:00Z", "2026-01-14", "2026-01-15"],
        ["2026-01-14T20:00:00Z", "2026-01-15T04:00:00Z", "2026-01-14", "2026-01-16"],
        ["2026-01-14T23:00:00Z", "2026-01-15T00:00:00Z", "2026-01-14", "2026-01-15"],
    ])("handles delivery window %s to %s", (start, end, from, to) => {
        expect(getSettlementRange(start, end)).toEqual({
            settlement_from: from,
            settlement_to: to,
        });
    });

    it("rejects an empty or reversed delivery window", () => {
        expect(() =>
            getSettlementRange(
                "2026-01-14T12:00:00Z",
                "2026-01-14T12:00:00Z",
            ),
        ).toThrow();
    });
});

describe("getPublicationWindow", () => {
    it("looks back 7 days from delivery start when that precedes the cutoff", () => {
        expect(PUBLICATION_LOOKBACK_HOURS).toBe(168);
        expect(
            getPublicationWindow(
                "2026-01-14T06:00:00Z",
                "2026-01-13T09:00:00Z",
            ),
        ).toEqual({
            publish_from: "2026-01-07T06:00:00Z",
            publish_to: "2026-01-13T09:00:00Z",
        });
    });

    it("avoids an inverted range when delivery is more than 7 days after cutoff", () => {
        const result = getPublicationWindow(
            "2026-01-31T00:00:00Z",
            "2026-01-14T09:00:00Z",
        );

        expect(Date.parse(result.publish_from)).toBeLessThanOrEqual(
            Date.parse(result.publish_to),
        );
        expect(result).toEqual({
            publish_from: "2026-01-07T09:00:00Z",
            publish_to: "2026-01-14T09:00:00Z",
        });
    });
});

describe("getExpectedHours", () => {
    it("treats delivery end as exclusive", () => {
        expect(
            getExpectedHours(
                "2026-01-14T00:00:00Z",
                "2026-01-15T00:00:00Z",
            ),
        ).toBe(24);
    });

    it("rejects a window that is not aligned to whole hours", () => {
        expect(() =>
            getExpectedHours(
                "2026-01-14T00:30:00Z",
                "2026-01-14T03:30:00Z",
            ),
        ).toThrow();
    });
});

const sampleResponse: AnalysisResponse = {
    publicationWindow: {
        from: "2026-01-10T00:00:00Z",
        to: "2026-01-13T09:00:00Z",
    },
    settlementWindow: {
        from: "2026-01-14",
        to: "2026-01-15",
    },
    decisionCutoff: "2026-01-13T09:00:00Z",
    deliveryStart: "2026-01-14T00:00:00Z",
    deliveryEnd: "2026-01-14T04:00:00Z",
    matchedPeriods: 3,
    mae: 10,
    comparisons: [
        {
            startTime: "2026-01-14T00:00:00Z",
            publishTime: "2026-01-13T04:30:00Z",
            forecastGeneration: 120,
            actualGeneration: 100,
            error: 20,
            absoluteError: 20,
        },
        {
            startTime: "2026-01-14T01:00:00Z",
            publishTime: "2026-01-13T04:30:00Z",
            forecastGeneration: 80,
            actualGeneration: 100,
            error: -20,
            absoluteError: 20,
        },
        {
            startTime: "2026-01-14T03:00:00Z",
            publishTime: "2026-01-13T04:30:00Z",
            forecastGeneration: 90,
            actualGeneration: 100,
            error: -10,
            absoluteError: 10,
        },
    ],
};

describe("getAnalysisStats", () => {
    it("computes coverage and averages over matched rows only", () => {
        expect(getAnalysisStats(sampleResponse)).toEqual({
            expectedHours: 4,
            matchedHours: 3,
            unmatchedHours: 1,
            coveragePercent: 75,
            meanForecast: (120 + 80 + 90) / 3,
            meanActual: 100,
            meanSignedError: (20 - 20 - 10) / 3,
            worstHours: sampleResponse.comparisons,
        });
    });

    it("returns null averages when there are no matched rows", () => {
        const empty = {
            ...sampleResponse,
            matchedPeriods: 0,
            mae: null,
            comparisons: [],
        };

        expect(getAnalysisStats(empty)).toMatchObject({
            expectedHours: 4,
            matchedHours: 0,
            unmatchedHours: 4,
            coveragePercent: 0,
            meanForecast: null,
            meanActual: null,
            meanSignedError: null,
            worstHours: [],
        });
    });

    it("treats mean signed error as forecast minus actual on matched hours", () => {
        const stats = getAnalysisStats(sampleResponse);

        expect(stats.meanSignedError).toBeCloseTo(-10 / 3);
        expect(stats.meanForecast! - stats.meanActual!).toBeCloseTo(
            stats.meanSignedError!,
        );
    });

    it("ranks worst hours by absolute error without mutating the response", () => {
        const rows = [...sampleResponse.comparisons];
        const stats = getAnalysisStats(sampleResponse);

        expect(stats.worstHours.map((row) => row.absoluteError)).toEqual([20, 20, 10]);
        expect(sampleResponse.comparisons).toEqual(rows);
    });
});

describe("getHourlyObservations", () => {
    it("includes unmatched hours without inventing forecast or actual values", () => {
        const observations = getHourlyObservations(
            sampleResponse.deliveryStart,
            sampleResponse.deliveryEnd,
            sampleResponse.comparisons,
        );

        expect(observations).toHaveLength(4);
        expect(observations.map((row) => row.matched)).toEqual([
            true,
            true,
            false,
            true,
        ]);
        expect(observations[2]).toMatchObject({
            startTime: "2026-01-14T02:00:00Z",
            forecastGeneration: null,
            actualGeneration: null,
            error: null,
            publishTime: null,
            matched: false,
        });
        expect(observations[0]?.leadTimeHours).toBe(19.5);
    });

    it("does not attribute a coverage gap to forecast or actual absence", () => {
        const gap = getHourlyObservations(
            sampleResponse.deliveryStart,
            sampleResponse.deliveryEnd,
            sampleResponse.comparisons,
        )[2];

        expect(gap?.forecastGeneration).toBeNull();
        expect(gap?.actualGeneration).toBeNull();
        expect(gap?.matched).toBe(false);
    });
});

describe("getLeadTimeHours", () => {
    it("calculates lead time across midnight", () => {
        expect(
            getLeadTimeHours(
                "2026-01-14T01:00:00Z",
                "2026-01-13T22:30:00Z",
            ),
        ).toBe(2.5);
    });
});

describe("areInputsStale", () => {
    const request: AnalysisRequest = {
        publish_from: "2026-01-10T00:00:00Z",
        publish_to: "2026-01-13T09:00:00Z",
        settlement_from: "2026-01-14",
        settlement_to: "2026-01-15",
        decision_cutoff: "2026-01-13T09:00:00Z",
        delivery_start: "2026-01-14T00:00:00Z",
        delivery_end: "2026-01-15T00:00:00Z",
    };

    it("is not stale before the first successful run", () => {
        expect(areInputsStale(request, null)).toBe(false);
    });

    it("detects changed inputs", () => {
        expect(
            areInputsStale(
                { ...request, decision_cutoff: "2026-01-13T10:00:00Z" },
                request,
            ),
        ).toBe(true);
    });

    it("clears stale status when inputs are restored", () => {
        expect(areInputsStale(request, { ...request })).toBe(false);
    });
});
