import request from "supertest";
import { createApp } from "../app";
import {
    aggregateTransparencyData,
    assertValidHistoryPoint,
    buildTransparencySummary,
    computeDeflationaryRatio,
    checkedAdd,
    checkedSum,
    resetTransparencyCache,
    roundToTwoDecimals,
    setTransparencyDataSource,
    TransparencyCalculationError,
    TransparencyValidationError,
    validateExternalHistory,
} from "../routes/transparency";
import { failoverIncidentHistoryService } from "../services/failoverIncidentHistoryService";

describe("GET /api/transparency/summary", () => {
    it("returns 200 with all required fields", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");

        expect(res.status).toBe(200);
        expect(typeof res.body.totalRevenueLumens).toBe("number");
        expect(typeof res.body.totalBurnedTokens).toBe("number");
        expect(typeof res.body.deflationaryRatio).toBe("number");
        expect(Array.isArray(res.body.history)).toBe(true);
    });

    it("returns 30 history entries", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");
        expect(res.body.history).toHaveLength(30);
    });

    it("each history entry has date, revenue, and burned", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");
        for (const entry of res.body.history) {
            expect(typeof entry.date).toBe("string");
            expect(typeof entry.revenue).toBe("number");
            expect(typeof entry.burned).toBe("number");
        }
    });

    it("totalRevenueLumens is sum of history revenues", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");
        const sumRevenue: number = res.body.history.reduce(
            (acc: number, h: { revenue: number }) => acc + h.revenue,
            0,
        );
        expect(res.body.totalRevenueLumens).toBeCloseTo(sumRevenue, 0);
    });

    it("does not expose cachedAt in the response", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");
        expect(res.body.cachedAt).toBeUndefined();
    });

    it("deflationaryRatio is between 0 and 100", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");
        expect(res.body.deflationaryRatio).toBeGreaterThanOrEqual(0);
        expect(res.body.deflationaryRatio).toBeLessThanOrEqual(100);
    });
});

describe("boundary-value calculations (#1914)", () => {
    it("computeDeflationaryRatio returns 0 at zero emissions", () => {
        expect(computeDeflationaryRatio(100, 0)).toBe(0);
        expect(computeDeflationaryRatio(0, 0)).toBe(0);
        expect(computeDeflationaryRatio(0, 300_000)).toBe(0);
    });

    it("computeDeflationaryRatio saturates at 100 and rounds half-up to 2dp", () => {
        expect(computeDeflationaryRatio(300_000, 300_000)).toBe(100);
        expect(computeDeflationaryRatio(600_000, 300_000)).toBe(100);
        expect(computeDeflationaryRatio(1, 3)).toBe(33.33);
        expect(computeDeflationaryRatio(100, 300_000)).toBe(0.03);
        expect(computeDeflationaryRatio(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1)).toBe(100);
    });

    it("computeDeflationaryRatio throws on negative or non-finite inputs", () => {
        expect(() => computeDeflationaryRatio(-1, 100)).toThrow(TransparencyCalculationError);
        expect(() => computeDeflationaryRatio(100, -1)).toThrow(TransparencyCalculationError);
        expect(() => computeDeflationaryRatio(NaN, 100)).toThrow(TransparencyCalculationError);
        expect(() => computeDeflationaryRatio(100, Infinity)).toThrow(TransparencyCalculationError);
    });

    it("roundToTwoDecimals and checkedAdd reject non-finite and overflow", () => {
        expect(roundToTwoDecimals(1.005)).toBe(1); // binary 1.005 is 1.00499...
        expect(roundToTwoDecimals(0)).toBe(0);
        expect(() => roundToTwoDecimals(NaN)).toThrow(TransparencyCalculationError);
        expect(() => roundToTwoDecimals(Infinity)).toThrow(TransparencyCalculationError);
        expect(checkedAdd(0, 0)).toBe(0);
        expect(checkedAdd(Number.MAX_SAFE_INTEGER - 2, 1)).toBe(Number.MAX_SAFE_INTEGER - 1);
        expect(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(TransparencyCalculationError);
        expect(() => checkedAdd(-1, 5)).toThrow(TransparencyCalculationError);
        expect(() => checkedAdd(NaN, 5)).toThrow(TransparencyCalculationError);
        expect(() => checkedSum([1, NaN, 3])).toThrow(TransparencyCalculationError);
        expect(checkedSum([])).toBe(0);
    });

    it("aggregateTransparencyData keeps returning finite bounded values", async () => {
        const data = await aggregateTransparencyData();
        expect(Number.isFinite(data.totalRevenueLumens)).toBe(true);
        expect(Number.isFinite(data.totalBurnedTokens)).toBe(true);
        expect(data.deflationaryRatio).toBeGreaterThanOrEqual(0);
        expect(data.deflationaryRatio).toBeLessThanOrEqual(100);
        for (const h of data.history) {
            expect(h.revenue).toBeGreaterThanOrEqual(0);
            expect(h.burned).toBeGreaterThanOrEqual(0);
        }
    });
});

describe("aggregateTransparencyData (direct)", () => {
    it("returns the same object on a second call within TTL (cached)", async () => {
        const first = await aggregateTransparencyData();
        const second = await aggregateTransparencyData();
        expect(first).toBe(second); // same reference means cache was used
    });
});

describe("failover incident history validation and retries", () => {
    beforeEach(() => failoverIncidentHistoryService.reset());

    it("rejects invalid incident data without creating a partial record", async () => {
        const app = createApp();
        const invalid = await request(app).post("/api/transparency/failover-history").send({
            protocolId: "blend",
            protocolName: "Blend",
            reasons: ["down"],
            startedAt: "not-a-timestamp",
        });
        expect(invalid.status).toBe(400);
        expect((await request(app).get("/api/transparency/failover-history")).body.incidents).toEqual([]);

        const valid = await request(app).post("/api/transparency/failover-history").send({
            protocolId: "blend",
            protocolName: "Blend",
            reasons: ["down"],
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(valid.status).toBe(201);
        expect(valid.body.id).toBe("1");
    });

    it("keeps an incident open after an invalid resolution and accepts a safe retry", async () => {
        const app = createApp();
        const created = await request(app).post("/api/transparency/failover-history").send({
            protocolId: "blend",
            protocolName: "Blend",
            reasons: ["status=down"],
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        const failed = await request(app)
            .post("/api/transparency/failover-history/blend/resolve")
            .send({ recoveredAt: "2025-12-31T23:59:00.000Z" });
        expect(failed.status).toBe(400);
        expect(failoverIncidentHistoryService.getHistory("blend")[0].resolved).toBe(false);

        const recovery = "2026-01-01T00:05:00.000Z";
        const resolved = await request(app)
            .post("/api/transparency/failover-history/blend/resolve")
            .send({ recoveredAt: recovery });
        const retried = await request(app)
            .post("/api/transparency/failover-history/blend/resolve")
            .send({ recoveredAt: recovery });
        expect(resolved.status).toBe(200);
        expect(retried.status).toBe(200);
        expect(retried.body.id).toBe(created.body.id);
        expect(retried.body.durationMs).toBe(300_000);
        expect(failoverIncidentHistoryService.getHistory("blend")).toHaveLength(1);
    });
});

describe("malformed external data hardening (#1913)", () => {
    beforeEach(() => {
        resetTransparencyCache();
        failoverIncidentHistoryService.reset();
    });

    afterEach(() => {
        resetTransparencyCache();
        failoverIncidentHistoryService.reset();
    });

    it("validates untrusted external history and summary fields at the boundary without mutating inputs", () => {
        const rawInput = {
            history: [
                { date: "2026-05-01", revenue: 12000.456, burned: 3200.129 },
                { date: "2026-05-02", revenue: 8000, burned: 1800 },
            ],
            totalEmissions: 10000,
        };
        const snapshot = JSON.parse(JSON.stringify(rawInput));

        const summary = buildTransparencySummary(rawInput);
        expect(summary.totalRevenueLumens).toBe(20000.46);
        expect(summary.totalBurnedTokens).toBe(5000.13);
        expect(summary.deflationaryRatio).toBe(50);
        expect(rawInput).toEqual(snapshot);

        const malformedPayloads: unknown[] = [
            null,
            undefined,
            "not-an-object",
            [],
            { history: [] },
            { history: "not-an-array" },
            { history: [null] },
            { history: [{ date: "not-a-date", revenue: 100, burned: 50 }] },
            { history: [{ date: "2026-02-30", revenue: 100, burned: 50 }] },
            { history: [{ date: "2026-05-01", revenue: "100", burned: 50 }] },
            { history: [{ date: "2026-05-01", revenue: 100, burned: null }] },
            {
                history: [{ date: "2026-05-01", revenue: 100, burned: 50 }],
                totalEmissions: "300000",
            },
            {
                history: [{ date: "2026-05-01", revenue: 100, burned: 50 }],
                totalEmissions: -1,
            },
        ];

        for (const payload of malformedPayloads) {
            expect(() => buildTransparencySummary(payload)).toThrow(TransparencyValidationError);
        }

        expect(() => assertValidHistoryPoint(null as never)).toThrow(TransparencyValidationError);
        expect(() => validateExternalHistory(null)).toThrow(TransparencyValidationError);
        expect(() => checkedSum("not-an-array" as never)).toThrow(TransparencyValidationError);
    });

    it("preserves existing cached state and balances when an external data refresh fails validation", async () => {
        const app = createApp();
        setTransparencyDataSource(() => ({
            history: [
                { date: "2026-05-01", revenue: 15000, burned: 3000 },
                { date: "2026-05-02", revenue: 25000, burned: 5000 },
            ],
            totalEmissions: 40000,
        }));

        const initial = await request(app).get("/api/transparency/summary");
        expect(initial.status).toBe(200);
        expect(initial.body.totalRevenueLumens).toBe(40000);
        expect(initial.body.totalBurnedTokens).toBe(8000);
        expect(initial.body.deflationaryRatio).toBe(20);

        // Next upstream fetch returns malformed external data
        setTransparencyDataSource(() => ({
            history: [{ date: "invalid-date", revenue: "NaN", burned: -999 }],
            totalEmissions: "bad",
        }));

        await expect(aggregateTransparencyData({ forceRefresh: true })).rejects.toThrow(
            TransparencyValidationError,
        );

        // Route preserves the previously validated snapshot balances
        const preserved = await request(app).get("/api/transparency/summary");
        expect(preserved.status).toBe(200);
        expect(preserved.body.totalRevenueLumens).toBe(40000);
        expect(preserved.body.totalBurnedTokens).toBe(8000);
        expect(preserved.body.deflationaryRatio).toBe(20);
        expect(preserved.body.history).toHaveLength(2);
    });

    it("returns a typed failure when cold-start external data is malformed and recovers on retry", async () => {
        const app = createApp();
        setTransparencyDataSource(() => ({
            history: [{ date: "2026-99-99", revenue: "corrupt", burned: 100 }],
        }));

        const failed = await request(app).get("/api/transparency/summary");
        expect(failed.status).toBe(500);
        expect(failed.body.code).toBe("MALFORMED_HISTORY_POINT");

        // Safe retry after external source recovers
        setTransparencyDataSource(() => ({
            history: [{ date: "2026-05-03", revenue: 10000, burned: 2500 }],
            totalEmissions: 10000,
        }));

        const recovered = await request(app).get("/api/transparency/summary");
        expect(recovered.status).toBe(200);
        expect(recovered.body.totalRevenueLumens).toBe(10000);
        expect(recovered.body.totalBurnedTokens).toBe(2500);
        expect(recovered.body.deflationaryRatio).toBe(25);
    });

    it("rejects malformed failover-history query parameters and request payloads without mutating incident state", async () => {
        const app = createApp();

        // Seed one valid incident
        const created = await request(app).post("/api/transparency/failover-history").send({
            protocolId: "blend",
            protocolName: "Blend",
            reasons: ["stale feed"],
            startedAt: "2026-05-01T00:00:00.000Z",
        });
        expect(created.status).toBe(201);

        // Malformed query parameter (array and whitespace)
        const arrayQuery = await request(app).get(
            "/api/transparency/failover-history?protocolId=blend&protocolId=soroswap",
        );
        expect(arrayQuery.status).toBe(400);
        expect(arrayQuery.body.code).toBe("INVALID_QUERY_PARAMETER");

        const blankQuery = await request(app).get(
            "/api/transparency/failover-history?protocolId=%20%20",
        );
        expect(blankQuery.status).toBe(400);
        expect(blankQuery.body.code).toBe("INVALID_QUERY_PARAMETER");

        // Malformed POST bodies (non-object array, non-string fields, non-string reason elements)
        const arrayBody = await request(app)
            .post("/api/transparency/failover-history")
            .send(["not-an-object"]);
        expect(arrayBody.status).toBe(400);
        expect(arrayBody.body.code).toBe("MALFORMED_INCIDENT_PAYLOAD");

        const nonStringFields = await request(app)
            .post("/api/transparency/failover-history")
            .send({
                protocolId: 123,
                protocolName: { bad: true },
                reasons: [456],
            });
        expect(nonStringFields.status).toBe(400);
        expect(nonStringFields.body.code).toBe("MALFORMED_INCIDENT_PAYLOAD");

        // Malformed resolve body
        const badResolve = await request(app)
            .post("/api/transparency/failover-history/blend/resolve")
            .send({ recoveredAt: 12345 });
        expect(badResolve.status).toBe(400);
        expect(badResolve.body.code).toBe("MALFORMED_INCIDENT_PAYLOAD");

        // State is untouched: still 1 open incident for blend
        const history = await request(app).get("/api/transparency/failover-history?protocolId=blend");
        expect(history.status).toBe(200);
        expect(history.body.incidents).toHaveLength(1);
        expect(history.body.incidents[0].resolved).toBe(false);
    });
});
