import request from "supertest";
import { createApp } from "../app";
import { aggregateTransparencyData } from "../routes/transparency";

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
