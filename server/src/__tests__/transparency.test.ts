import request from "supertest";
import { createApp } from "../app";
import { aggregateTransparencyData } from "../routes/transparency";
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
