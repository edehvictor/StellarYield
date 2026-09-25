import { exportService, IDEMPOTENCY_KEY_TTL_MS } from "../services/exportService";

describe("ExportService", () => {
  it("should generate a valid snapshot bundle", async () => {
    const bundle = await exportService.generateSnapshotBundle();

    expect(bundle).toBeDefined();
    expect(bundle.timestamp).toBeDefined();
    expect(new Date(bundle.timestamp).getTime()).toBeGreaterThan(0);
    expect(bundle.version).toBe("1.0.0");
    expect(Array.isArray(bundle.opportunities)).toBe(true);
    expect(bundle.opportunities.length).toBeGreaterThan(0);
    expect(bundle.metadata.totalOpportunities).toBe(bundle.opportunities.length);
  });

  it("should contain all required fields in opportunity snapshots", async () => {
    const bundle = await exportService.generateSnapshotBundle();
    const opportunity = bundle.opportunities[0];

    expect(opportunity.id).toBeDefined();
    expect(opportunity.name).toBeDefined();
    expect(opportunity.apy).toBeDefined();
    expect(opportunity.tvlUsd).toBeDefined();
    expect(opportunity.riskScore).toBeDefined();
    expect(opportunity.riskAdjustedYield).toBeDefined();
    
    // Reliability fields
    expect(opportunity.reliability.score).toBeDefined();
    expect(opportunity.reliability.status).toBeDefined();
    expect(opportunity.reliability.freshness).toBeDefined();

    // Confidence fields
    expect(opportunity.confidence.score).toBeDefined();
    expect(opportunity.confidence.label).toBeDefined();
    expect(opportunity.confidence.factors).toBeDefined();
    expect(opportunity.confidence.factors.freshness).toBeDefined();
    expect(opportunity.confidence.factors.liquidityQuality).toBeDefined();

    // Metadata fields
    expect(opportunity.metadata.source).toBeDefined();
    expect(opportunity.metadata.fetchedAt).toBeDefined();
  });

  it("should exclude sensitive information", async () => {
    const bundle = await exportService.generateSnapshotBundle();
    const bundleString = JSON.stringify(bundle);

    // List of strings that should NOT be in the export (secrets, etc)
    const sensitiveKeys = ['apiKey', 'secret', 'password', 'privateKey', 'token'];
    
    sensitiveKeys.forEach(key => {
      expect(bundleString).not.toContain(`"${key}"`);
    });
  });

  it("should have consistent total count", async () => {
    const bundle = await exportService.generateSnapshotBundle();
    expect(bundle.opportunities.length).toBe(bundle.metadata.totalOpportunities);
  });

  // ---- Idempotency key tests ----

  describe("Idempotency key", () => {
    const key = "test-key-" + Date.now();
    const params = { address: "addr1", type: "csv-export" };
    const dummyResult = {
      version: "1.0.0",
      generatedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      appVersion: "1.0.0",
      opportunities: [],
      metadata: {
        totalOpportunities: 0,
        scoringMethodology: "csv-export",
        sourceFreshness: 0,
        filtersApplied: {},
      },
    };

    it("should return miss when key is unknown", () => {
      const check = exportService.checkIdempotency(key + "-miss", params);
      expect(check.status).toBe("miss");
      expect(check.result).toBeUndefined();
    });

    it("should return hit with cached result on duplicate request", () => {
      exportService.storeIdempotentResult(key, params, dummyResult);
      const check = exportService.checkIdempotency(key, params);
      expect(check.status).toBe("hit");
      expect(check.result).toBeDefined();
      expect(check.result!.version).toBe("1.0.0");
    });

    it("should reject with mismatch when same key has different params", () => {
      const mismatchParams = { address: "addr2", type: "csv-export" };
      const check = exportService.checkIdempotency(key, mismatchParams);
      expect(check.status).toBe("mismatch");
    });

    it("should treat expired keys as stale and allow reuse", () => {
      const staleKey = key + "-stale";
      // Manually insert an entry that is already past TTL
      const cache = (exportService as any).idempotencyCache as Map<string, any>;
      cache.set(staleKey, {
        key: staleKey,
        params,
        result: dummyResult,
        createdAt: Date.now() - IDEMPOTENCY_KEY_TTL_MS - 1,
      });

      const check = exportService.checkIdempotency(staleKey, params);
      expect(check.status).toBe("stale");
      expect(check.result).toBeUndefined();
      // The stale entry should have been cleaned up
      expect(cache.has(staleKey)).toBe(false);
    });

    it("should allow a new request after stale key was cleared", () => {
      const reuseKey = key + "-reuse";
      // Insert expired entry
      const cache = (exportService as any).idempotencyCache as Map<string, any>;
      cache.set(reuseKey, {
        key: reuseKey,
        params,
        result: dummyResult,
        createdAt: Date.now() - IDEMPOTENCY_KEY_TTL_MS - 1,
      });

      // First check clears the stale entry
      const staleCheck = exportService.checkIdempotency(reuseKey, params);
      expect(staleCheck.status).toBe("stale");

      // Now store a fresh result with the same key
      exportService.storeIdempotentResult(reuseKey, params, dummyResult);
      const hitCheck = exportService.checkIdempotency(reuseKey, params);
      expect(hitCheck.status).toBe("hit");
      expect(hitCheck.result).toBeDefined();
    });
  });
});
