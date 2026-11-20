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

// ── #1917: insufficient diagnostic context ────────────────────────────────

type Snapshot = Awaited<ReturnType<typeof aggregateTransparencyData>>;

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    const history = [{ date: "2026-11-18", revenue: 1_000, burned: 100 }];
    return {
        totalRevenueLumens: 1_000,
        totalBurnedTokens: 100,
        deflationaryRatio: 1,
        history,
        cachedAt: Date.now(),
        configFingerprint: getTransparencyConfigFingerprint(),
        ...overrides,
    };
}

const secretBearingError = () =>
    Promise.reject(
        new Error(
            "fetch to https://horizon.internal.example.com failed for GDXCN5BQ4RJXFTDMCTP3H7J6P5PT7PNZ4VP5G7F5VZ6B7K4Q7ZQ7ZQ7Z at /srv/app/server/src/routes/transparency.ts:1:1",
        ),
    );

describe("GET /api/transparency/summary – diagnostic hardening (#1917)", () => {
    beforeEach(() => {
        __resetTransparencyStateForTesting();
    });

    afterEach(() => {
        __resetTransparencyStateForTesting();
    });

    it("normal operation reports healthy status with no diagnostics", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("healthy");
        expect(res.body.diagnostics).toEqual([]);
        expect(res.body.history).toHaveLength(30);
        expect(res.body.cachedAt).toBeUndefined();
    });

    it("returns a privacy-safe diagnostic when aggregation fails with no prior snapshot", async () => {
        __setTransparencyAggregatorForTesting(secretBearingError);

        const res = await request(createApp()).get("/api/transparency/summary");

        expect(res.status).toBe(503);
        expect(res.body.status).toBe("unavailable");
        expect(res.body.diagnostics).toHaveLength(1);

        const [diagnostic] = res.body.diagnostics;
        expect(diagnostic.code).toBe("NO_DATA_AVAILABLE");
        expect(diagnostic.stage).toBe("aggregation");
        expect(diagnostic.retryable).toBe(true);
        expect(diagnostic.privacySafe).toBe(true);
        expect(typeof diagnostic.remediation).toBe("string");

        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain("horizon.internal.example.com");
        expect(serialized).not.toContain("GDXCN5BQ4RJXFTDMCTP3H7J6P5PT7PNZ4VP5G7F5VZ6B7K4Q7ZQ7ZQ7Z");
        expect(serialized).not.toContain("/srv/app");
        expect(serialized).not.toMatch(/at aggregate/);
    });

    it("preserves the last known-good snapshot and balances when a later aggregation fails", async () => {
        __setTransparencyAggregatorForTesting(async () => makeSnapshot());
        const warm = await request(createApp()).get("/api/transparency/summary");
        expect(warm.status).toBe(200);
        expect(warm.body.status).toBe("healthy");

        // Simulate the aggregation window expiring, then a failing retry.
        __expireTransparencyCacheForTesting();
        __setTransparencyAggregatorForTesting(secretBearingError);

        const degraded = await request(createApp()).get("/api/transparency/summary");

        expect(degraded.status).toBe(200);
        expect(degraded.body.status).toBe("degraded");
        expect(degraded.body.totalRevenueLumens).toBe(warm.body.totalRevenueLumens);
        expect(degraded.body.totalBurnedTokens).toBe(warm.body.totalBurnedTokens);
        expect(degraded.body.deflationaryRatio).toBe(warm.body.deflationaryRatio);
        expect(degraded.body.history).toEqual(warm.body.history);

        expect(degraded.body.diagnostics.map((d: { code: string }) => d.code)).toEqual([
            "AGGREGATION_FAILED",
            "STALE_LAST_KNOWN",
        ]);
        expect(degraded.body.diagnostics[0].stage).toBe("aggregation");
        expect(degraded.body.diagnostics[1].stage).toBe("cache");
        for (const diagnostic of degraded.body.diagnostics) {
            expect(diagnostic.privacySafe).toBe(true);
            expect(diagnostic.remediation.length).toBeGreaterThan(0);
        }
    });

    it("treats an invalid snapshot as a failure instead of overwriting good state", async () => {
        __setTransparencyAggregatorForTesting(async () => makeSnapshot());
        const warm = await request(createApp()).get("/api/transparency/summary");
        expect(warm.status).toBe(200);

        __expireTransparencyCacheForTesting();
        __setTransparencyAggregatorForTesting(async () =>
            makeSnapshot({ totalRevenueLumens: Number.NaN, history: [] }),
        );

        const res = await request(createApp()).get("/api/transparency/summary");

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("degraded");
        expect(res.body.totalRevenueLumens).toBe(warm.body.totalRevenueLumens);
        expect(res.body.diagnostics[0].code).toBe("AGGREGATION_FAILED");
        expect(res.body.history).toEqual(warm.body.history);
    });

    it("rejects snapshots whose totals do not match their history", () => {
        expect(validateTransparencyData(makeSnapshot())).toBe(true);
        expect(validateTransparencyData(makeSnapshot({ totalRevenueLumens: 999 }))).toBe(false);
        expect(validateTransparencyData(makeSnapshot({ history: [] }))).toBe(false);
        expect(validateTransparencyData(null)).toBe(false);
    });

    it("retries safely once aggregation recovers, without losing or double-applying state", async () => {
        __setTransparencyAggregatorForTesting(async () => makeSnapshot());
        await request(createApp()).get("/api/transparency/summary");

        __expireTransparencyCacheForTesting();
        __setTransparencyAggregatorForTesting(secretBearingError);
        const failed = await request(createApp()).get("/api/transparency/summary");
        expect(failed.body.status).toBe("degraded");

        // Retry after recovery: the stage rebuilds a fresh snapshot.
        __setTransparencyAggregatorForTesting(async () =>
            makeSnapshot({
                history: [{ date: "2026-11-19", revenue: 1_500, burned: 150 }],
                totalRevenueLumens: 1_500,
                totalBurnedTokens: 150,
                deflationaryRatio: 2,
            }),
        );

        const retried = await request(createApp()).get("/api/transparency/summary");

        expect(retried.status).toBe(200);
        expect(retried.body.status).toBe("healthy");
        expect(retried.body.diagnostics).toEqual([]);
        expect(retried.body.totalRevenueLumens).toBe(1_500);
        expect(retried.body.totalBurnedTokens).toBe(150);
        expect(retried.body.deflationaryRatio).toBe(2);
    });
});

// ── #1910: stale configuration snapshots ──────────────────────────────────

describe("GET /api/transparency/summary – stale configuration snapshots (#1910)", () => {
    beforeEach(() => {
        __resetTransparencyStateForTesting();
    });

    afterEach(() => {
        __resetTransparencyStateForTesting();
    });

    it("stamps a stable config fingerprint on a normal read", async () => {
        const res = await request(createApp()).get("/api/transparency/summary");

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("healthy");
        expect(res.body.diagnostics).toEqual([]);
        expect(res.body.configFingerprint).toBe(getTransparencyConfigFingerprint());
        expect(res.body.snapshotConfigFingerprint).toBe(res.body.configFingerprint);

        const again = await request(createApp()).get("/api/transparency/summary");
        expect(again.body.configFingerprint).toBe(res.body.configFingerprint);
    });

    it("changes the fingerprint when the configuration changes", () => {
        const before = getTransparencyConfigFingerprint();
        __setTransparencyConfigForTesting({ cacheTtlMs: 1 });
        const after = getTransparencyConfigFingerprint();

        expect(after).not.toBe(before);
        expect(after).toMatch(/^cfg1:[0-9a-f]{16}$/);
    });

    it("rejects a cached snapshot when the configuration no longer matches", async () => {
        let aggregations = 0;
        __setTransparencyAggregatorForTesting(async () => {
            aggregations += 1;
            return makeSnapshot({
                totalRevenueLumens: 1_000 * aggregations,
                history: [
                    { date: "2026-11-18", revenue: 1_000 * aggregations, burned: 100 },
                ],
            });
        });

        const warm = await request(createApp()).get("/api/transparency/summary");
        expect(warm.status).toBe(200);
        expect(warm.body.totalRevenueLumens).toBe(1_000);
        expect(aggregations).toBe(1);

        // The config changes while the cached snapshot is still fresh.
        __setTransparencyConfigForTesting({ horizonUrl: "https://new-horizon.example.com" });

        const afterChange = await request(createApp()).get("/api/transparency/summary");

        // The stale-config cache entry must not be served; work is refreshed.
        expect(aggregations).toBe(2);
        expect(afterChange.status).toBe(200);
        expect(afterChange.body.status).toBe("healthy");
        expect(afterChange.body.diagnostics).toEqual([]);
        expect(afterChange.body.totalRevenueLumens).toBe(2_000);
        expect(afterChange.body.snapshotConfigFingerprint).toBe(
            afterChange.body.configFingerprint,
        );
        expect(afterChange.body.configFingerprint).not.toBe(warm.body.configFingerprint);
    });

    it("rejects an aggregator snapshot that declares a different configuration", async () => {
        __setTransparencyConfigForTesting({ horizonUrl: "https://active-horizon.example.com" });
        __setTransparencyAggregatorForTesting(async () =>
            makeSnapshot({ configFingerprint: "cfg1:0000000000000000" }),
        );

        const res = await request(createApp()).get("/api/transparency/summary");

        expect(res.status).toBe(503);
        expect(res.body.status).toBe("unavailable");
        expect(res.body.diagnostics[0].code).toBe("NO_DATA_AVAILABLE");

        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain("config fingerprint mismatch");
        expect(serialized).not.toContain("active-horizon.example.com");
    });

    it("preserves last known-good snapshot and balances on failure, marking it stale after a config change", async () => {
        __setTransparencyAggregatorForTesting(async () => makeSnapshot());
        const warm = await request(createApp()).get("/api/transparency/summary");
        expect(warm.status).toBe(200);
        expect(warm.body.status).toBe("healthy");

        // Configuration changes, then the refresh fails.
        __setTransparencyConfigForTesting({ historyDays: 7 });
        __expireTransparencyCacheForTesting();
        __setTransparencyAggregatorForTesting(secretBearingError);

        const degraded = await request(createApp()).get("/api/transparency/summary");

        expect(degraded.status).toBe(200);
        expect(degraded.body.status).toBe("degraded");
        // Existing metrics are preserved rather than blanked out.
        expect(degraded.body.totalRevenueLumens).toBe(warm.body.totalRevenueLumens);
        expect(degraded.body.totalBurnedTokens).toBe(warm.body.totalBurnedTokens);
        expect(degraded.body.deflationaryRatio).toBe(warm.body.deflationaryRatio);
        expect(degraded.body.history).toEqual(warm.body.history);

        expect(degraded.body.diagnostics.map((d: { code: string }) => d.code)).toEqual([
            "AGGREGATION_FAILED",
            "CONFIG_SNAPSHOT_STALE",
            "STALE_LAST_KNOWN",
        ]);
        expect(degraded.body.diagnostics[1].stage).toBe("configuration");
        expect(degraded.body.diagnostics[1].severity).toBe("critical");
        expect(degraded.body.diagnostics[1].privacySafe).toBe(true);
        expect(degraded.body.snapshotConfigFingerprint).toBe(
            warm.body.snapshotConfigFingerprint,
        );
        expect(degraded.body.configFingerprint).not.toBe(
            degraded.body.snapshotConfigFingerprint,
        );
    });

    it("does not mark a preserved snapshot stale when the configuration is unchanged", async () => {
        __setTransparencyAggregatorForTesting(async () => makeSnapshot());
        await request(createApp()).get("/api/transparency/summary");

        __expireTransparencyCacheForTesting();
        __setTransparencyAggregatorForTesting(secretBearingError);

        const degraded = await request(createApp()).get("/api/transparency/summary");

        expect(degraded.body.status).toBe("degraded");
        expect(degraded.body.diagnostics.map((d: { code: string }) => d.code)).toEqual([
            "AGGREGATION_FAILED",
            "STALE_LAST_KNOWN",
        ]);
        expect(degraded.body.configFingerprint).toBe(degraded.body.snapshotConfigFingerprint);
    });

    it("retries safely after a configuration change and rebuilds under the new config", async () => {
        __setTransparencyAggregatorForTesting(async () => makeSnapshot());
        await request(createApp()).get("/api/transparency/summary");

        __setTransparencyConfigForTesting({ horizonUrl: "https://changed.example.com" });
        __setTransparencyAggregatorForTesting(secretBearingError);
        const failed = await request(createApp()).get("/api/transparency/summary");
        expect(failed.body.status).toBe("degraded");

        __setTransparencyAggregatorForTesting(async () =>
            makeSnapshot({
                history: [{ date: "2026-11-19", revenue: 1_500, burned: 150 }],
                totalRevenueLumens: 1_500,
                totalBurnedTokens: 150,
                deflationaryRatio: 2,
            }),
        );

        const retried = await request(createApp()).get("/api/transparency/summary");

        expect(retried.status).toBe(200);
        expect(retried.body.status).toBe("healthy");
        expect(retried.body.diagnostics).toEqual([]);
        expect(retried.body.totalRevenueLumens).toBe(1_500);
        expect(retried.body.configFingerprint).toBe(getTransparencyConfigFingerprint());
        expect(retried.body.snapshotConfigFingerprint).toBe(
            retried.body.configFingerprint,
        );
    });

    it("clears the config override on reset", () => {
        const before = getTransparencyConfigFingerprint();
        __setTransparencyConfigForTesting({ cacheTtlMs: 5 });
        expect(getTransparencyConfigFingerprint()).not.toBe(before);

        __resetTransparencyStateForTesting();
        expect(getTransparencyConfigFingerprint()).toBe(before);
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
