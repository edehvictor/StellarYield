import { exportService } from '../exportService';
import { describe, it, expect } from '@jest/globals';

describe('ExportService', () => {
  it('should generate a snapshot bundle with enhanced metadata', async () => {
    const filters = { protocol: 'blend' };
    const bundle = await exportService.generateSnapshotBundle(filters);

    expect(bundle).toHaveProperty('generatedAt');
    expect(bundle).toHaveProperty('appVersion', '1.0.0');
    expect(bundle).toHaveProperty('opportunities');
    expect(Array.isArray(bundle.opportunities)).toBe(true);

    expect(bundle.metadata).toHaveProperty('totalOpportunities');
    expect(bundle.metadata).toHaveProperty('scoringMethodology');
    expect(bundle.metadata).toHaveProperty('sourceFreshness');
    expect(bundle.metadata.filtersApplied).toEqual(filters);
    
    // Validate generatedAt is a valid ISO string
    expect(new Date(bundle.generatedAt).toISOString()).toBe(bundle.generatedAt);
  });

  it('should calculate sourceFreshness correctly', async () => {
    const bundle = await exportService.generateSnapshotBundle();
    
    if (bundle.opportunities.length > 0) {
      const sumFreshness = bundle.opportunities.reduce(
        (acc, op) => acc + op.reliability.freshness, 
        0
      );
      const expectedAvg = Math.round((sumFreshness / bundle.opportunities.length) * 100) / 100;
      expect(bundle.metadata.sourceFreshness).toBe(expectedAvg);
    } else {
      expect(bundle.metadata.sourceFreshness).toBe(0);
    }
  });

  it('should exclude private wallet data from opportunities', async () => {
    const bundle = await exportService.generateSnapshotBundle();
    
    for (const op of bundle.opportunities) {
      // Ensure no sensitive keys exist in the exported data
      expect(op).not.toHaveProperty('walletAddress');
      expect(op).not.toHaveProperty('privateKey');
      expect(op).not.toHaveProperty('secret');
    }
  });
});
