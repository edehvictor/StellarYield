import { exportService } from "../services/exportService";

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
});
