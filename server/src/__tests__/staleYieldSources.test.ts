import request from "supertest";
import { createApp } from "../app";
import { yieldReliabilityEngine } from "../services/yieldReliabilityService";

describe("Yield recommendations reliability and freshness check", () => {
  const app = createApp();

  beforeEach(() => {
    // Clear any previous test overrides and caches
    yieldReliabilityEngine.clearCache();
    yieldReliabilityEngine.setSignalOverride("blend_api", null);
    yieldReliabilityEngine.setSignalOverride("soroswap_api", null);
  });

  afterEach(() => {
    yieldReliabilityEngine.clearCache();
    yieldReliabilityEngine.setSignalOverride("blend_api", null);
    yieldReliabilityEngine.setSignalOverride("soroswap_api", null);
  });

  it("should recommend healthy, fresh yield sources on the leaderboard", async () => {
    const res = await request(app).get("/api/strategies/leaderboard");

    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    // Default mock behavior is healthy, so we expect the main protocols to be included
    const itemIds = res.body.items.map((item: any) => item.id);
    expect(itemIds).toContain("blend");
    expect(itemIds).toContain("soroswap");
    expect(res.body.warnings).toEqual([]);
  });

  it("should exclude stale yield sources from recommendations on the leaderboard", async () => {
    // Set Blend data as stale (e.g. 1 hour old)
    const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    yieldReliabilityEngine.setSignalOverride("blend_api", {
      lastSuccessfulFetch: oldTimestamp,
    });

    const res = await request(app).get("/api/strategies/leaderboard");

    expect(res.status).toBe(200);
    const itemIds = res.body.items.map((item: any) => item.id);
    // Blend should be excluded from recommended items
    expect(itemIds).not.toContain("blend");
    // Soroswap should still be recommended
    expect(itemIds).toContain("soroswap");
    // Decision log and warnings should contain references to stale data
    expect(res.body.failover.excluded).toContain("blend");
    expect(res.body.warnings.some((w: string) => w.includes("stale") && w.includes("Blend"))).toBe(true);
  });

  it("should exclude unhealthy down yield sources from leaderboard recommendations", async () => {
    // Set Soroswap status as unreliable (consecutiveFailures = 5)
    yieldReliabilityEngine.setSignalOverride("soroswap_api", {
      consecutiveFailures: 5,
      successfulRequests: 0,
      totalRequests: 10,
    });

    const res = await request(app).get("/api/strategies/leaderboard");

    expect(res.status).toBe(200);
    const itemIds = res.body.items.map((item: any) => item.id);
    expect(itemIds).toContain("blend");
    expect(itemIds).not.toContain("soroswap");
    expect(res.body.failover.excluded).toContain("soroswap");
    expect(res.body.warnings.some((w: string) => w.includes("unhealthy") || w.includes("excluded"))).toBe(true);
  });

  it("should return stale/degraded flags and warning metadata in yields endpoint", async () => {
    // Set Blend data to stale
    const oldTimestamp = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    yieldReliabilityEngine.setSignalOverride("blend_api", {
      lastSuccessfulFetch: oldTimestamp,
    });

    const res = await request(app).get("/api/yields");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const blendEntry = res.body.find((e: any) => e.protocolName === "Blend");
    expect(blendEntry).toBeDefined();
    expect(blendEntry.isStale).toBe(true);
    expect(blendEntry.warnings.some((w: string) => w.includes("stale"))).toBe(true);
  });
});
