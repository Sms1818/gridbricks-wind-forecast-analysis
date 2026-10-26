import { afterEach, describe, expect, it, vi } from "vitest";

import {
    AnalysisApiError,
    runAnalysis,
} from "./analysisApi";

import type {
    AnalysisRequest,
    AnalysisResponse,
} from "../domain/analysis";

const request: AnalysisRequest = {
    publish_from: "2026-01-13T00:00:00Z",
    publish_to: "2026-01-14T09:00:00Z",
    settlement_from: "2026-01-14T00:00:00Z",
    settlement_to: "2026-01-15T00:00:00Z",
    decision_cutoff: "2026-01-14T09:00:00Z",
    delivery_start: "2026-01-14T00:00:00Z",
    delivery_end: "2026-01-15T00:00:00Z",
};

const validResponse: AnalysisResponse = {
    publicationWindow: {
        from: request.publish_from,
        to: request.publish_to,
    },
    settlementWindow: {
        from: request.settlement_from,
        to: request.settlement_to,
    },
    decisionCutoff: request.decision_cutoff,
    deliveryStart: request.delivery_start,
    deliveryEnd: request.delivery_end,
    matchedPeriods: 1,
    mae: 20,
    comparisons: [
        {
            startTime: "2026-01-14T00:00:00Z",
            publishTime: "2026-01-14T08:00:00Z",
            forecastGeneration: 120,
            actualGeneration: 100,
            error: 20,
            absoluteError: 20,
        },
    ],
};

function mockResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function mockFetch(data: unknown, status = 200): void {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockResponse(data, status)),
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("runAnalysis", () => {
    it("returns a valid analysis response", async () => {
        mockFetch(validResponse);

        await expect(runAnalysis(request)).resolves.toEqual(validResponse);
    });

    it("sends the requested parameters to the API", async () => {
        mockFetch(validResponse);

        await runAnalysis(request);

        expect(fetch).toHaveBeenCalledTimes(1);

        const [url, options] = vi.mocked(fetch).mock.calls[0];

        expect(String(url)).toContain(
            "/api/analysis/forecast-accuracy?",
        );
        expect(options?.method).toBe("GET");

        const parsedUrl = new URL(String(url), "http://localhost");

        for (const [key, value] of Object.entries(request)) {
            expect(parsedUrl.searchParams.get(key)).toBe(value);
        }
    });

    it("rejects a matched-period count that disagrees with the rows", async () => {
        mockFetch({
            ...validResponse,
            matchedPeriods: 2,
        });

        await expect(runAnalysis(request)).rejects.toThrow(
            "matched-period count does not agree",
        );
    });

    it("rejects an incorrect signed forecast error", async () => {
        mockFetch({
            ...validResponse,
            comparisons: [
                {
                    ...validResponse.comparisons[0],
                    error: -20,
                    absoluteError: 20,
                },
            ],
        });

        await expect(runAnalysis(request)).rejects.toThrow(
            "inconsistent signed forecast error",
        );
    });

    it("rejects an incorrect MAE", async () => {
        mockFetch({
            ...validResponse,
            mae: 25,
        });

        await expect(runAnalysis(request)).rejects.toThrow(
            "reported MAE does not agree",
        );
    });

    it("rejects duplicate delivery hours", async () => {
        const row = validResponse.comparisons[0];

        mockFetch({
            ...validResponse,
            matchedPeriods: 2,
            mae: 20,
            comparisons: [
                row,
                {
                    ...row,
                    publishTime: "2026-01-14T08:30:00Z",
                },
            ],
        });

        await expect(runAnalysis(request)).rejects.toThrow(
            "duplicate delivery hours",
        );
    });

    it("rejects a forecast published after the decision cutoff", async () => {
        mockFetch({
            ...validResponse,
            comparisons: [
                {
                    ...validResponse.comparisons[0],
                    publishTime: "2026-01-14T10:00:00Z",
                },
            ],
        });

        await expect(runAnalysis(request)).rejects.toThrow(
            "published after the decision cutoff",
        );
    });

    it("accepts an empty result when MAE is null", async () => {
        const emptyResponse: AnalysisResponse = {
            ...validResponse,
            matchedPeriods: 0,
            mae: null,
            comparisons: [],
        };

        mockFetch(emptyResponse);

        await expect(runAnalysis(request)).resolves.toEqual(emptyResponse);
    });

    it("rejects a non-empty result with null MAE", async () => {
        mockFetch({
            ...validResponse,
            mae: null,
        });

        await expect(runAnalysis(request)).rejects.toThrow(
            "MAE is inconsistent",
        );
    });

    it("rejects an unexpected response shape", async () => {
        mockFetch({
            matchedPeriods: "one",
        });

        await expect(runAnalysis(request)).rejects.toBeInstanceOf(
            AnalysisApiError,
        );
    });

    it("reports HTTP 400 as a validation error", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response("Invalid request", { status: 400 }),
            ),
        );

        try {
            await runAnalysis(request);
            throw new Error("Expected runAnalysis to reject");
        } catch (error) {
            expect(error).toBeInstanceOf(AnalysisApiError);
            expect(error).toMatchObject({
                kind: "validation",
                status: 400,
                message: "Invalid request",
            });
        }
    });

    it("reports HTTP 502 as an upstream error", async () => {
        mockFetch({}, 502);

        await expect(runAnalysis(request)).rejects.toMatchObject({
            kind: "upstream",
            status: 502,
        });
    });
});
