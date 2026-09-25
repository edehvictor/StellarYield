import request from "supertest";
import { createApp } from "../app";

describe("GET /api/analytics/sources/health", () => {
  it("returns 200 with the registry envelope", async () => {
    const res = await request(createApp()).get("/api/analytics/sources/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.generatedAt).toBe("string");
    expect(typeof res.body.data.totalSources).toBe("number");
    expect(Array.isArray(res.body.data.sources)).toBe(true);
  });

  it("returns one summary per source with the documented fields", async () => {
    const res = await request(createApp()).get("/api/analytics/sources/health");
    const { sources, totalSources, counts } = res.body.data;

    expect(sources).toHaveLength(totalSources);
    for (const source of sources) {
      expect(typeof source.providerId).toBe("string");
      expect(typeof source.providerName).toBe("string");
      expect(["healthy", "degraded", "stale", "unavailable"]).toContain(
        source.status,
      );
      expect(typeof source.uptimePct).toBe("number");
      expect(typeof source.latencyMs).toBe("number");
      expect(typeof source.latestFetch).toBe("string");
    }

    const summed =
      counts.healthy + counts.degraded + counts.stale + counts.unavailable;
    expect(summed).toBe(totalSources);
  });
});
