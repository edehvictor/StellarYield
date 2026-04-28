/**
 * Unit tests for MetricAggregator
 * 
 * These tests verify specific scenarios and error handling.
 */

import { MetricAggregator, NormalizedYield, IYieldService } from '../../services/fragmentation/MetricAggregator';
import { FragmentationError } from '../../services/fragmentation/types';

describe('MetricAggregator - Unit Tests', () => {
  let mockYieldService: IYieldService;

  beforeEach(() => {
    mockYieldService = {
      getYieldData: jest.fn(),
    };
  });

  describe('aggregatePoolDepth', () => {
    it('successfully aggregates data from all protocols', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
        { protocol: 'Soroswap', tvl: 4850000, apy: 6.2, poolCount: 30 },
        { protocol: 'DeFindex', tvl: 2100000, apy: 7.8, poolCount: 15 },
        { protocol: 'Aquarius', tvl: 1650000, apy: 5.5, poolCount: 20 },
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      const result = await aggregator.aggregatePoolDepth();

      expect(result.protocols).toHaveLength(4);
      expect(result.totalTvlUsd).toBe(21000000);
      expect(result.dataCompleteness.poolDepthAvailable).toBe(true);
      expect(result.dataCompleteness.missingProtocols).toHaveLength(0);
      expect(result.timestamp).toBeDefined();
    });

    it('handles partial data with missing protocols', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
        { protocol: 'Soroswap', tvl: 4850000, apy: 6.2, poolCount: 30 },
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      const result = await aggregator.aggregatePoolDepth();

      expect(result.protocols).toHaveLength(2);
      expect(result.dataCompleteness.missingProtocols).toContain('DeFindex');
      expect(result.dataCompleteness.missingProtocols).toContain('Aquarius');
    });

    it('normalizes data with missing poolCount', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5 }, // No poolCount
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      const result = await aggregator.aggregatePoolDepth();

      expect(result.protocols[0].poolCount).toBe(1); // Default to 1
      expect(result.protocols[0].avgDepthUsd).toBe(12400000);
    });

    it('normalizes data with missing timestamp', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      const result = await aggregator.aggregatePoolDepth();

      expect(result.protocols[0].fetchedAt).toBeDefined();
      expect(typeof result.protocols[0].fetchedAt).toBe('string');
    });

    it('caches successful results', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      await aggregator.aggregatePoolDepth();

      const cachedData = aggregator.getCachedData();
      expect(cachedData).not.toBeNull();
      expect(cachedData?.protocols).toHaveLength(1);
    });

    it('returns stale cached data when fetch fails', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
      ];

      // First call succeeds
      (mockYieldService.getYieldData as jest.Mock).mockResolvedValueOnce(mockData);
      const aggregator = new MetricAggregator(mockYieldService);
      await aggregator.aggregatePoolDepth();

      // Second call fails
      (mockYieldService.getYieldData as jest.Mock).mockRejectedValueOnce(
        new Error('Service unavailable')
      );

      const result = await aggregator.aggregatePoolDepth();
      expect(result.dataCompleteness.isStale).toBe(true);
      expect(result.dataCompleteness.staleSince).toBeDefined();
    });

    it('throws error when no data available and no cache', async () => {
      (mockYieldService.getYieldData as jest.Mock).mockRejectedValue(
        new Error('Service unavailable')
      );

      const aggregator = new MetricAggregator(mockYieldService);

      await expect(aggregator.aggregatePoolDepth()).rejects.toThrow(FragmentationError);
      await expect(aggregator.aggregatePoolDepth()).rejects.toThrow('no cached data available');
    });
  });

  describe('handlePartialData', () => {
    it('correctly identifies missing protocols', () => {
      const availableData = [
        {
          protocol: 'Blend',
          tvlUsd: 12400000,
          poolCount: 50,
          avgDepthUsd: 248000,
          fetchedAt: new Date().toISOString(),
        },
      ];

      const aggregator = new MetricAggregator(mockYieldService);
      const result = aggregator.handlePartialData(availableData, [
        'Blend',
        'Soroswap',
        'DeFindex',
      ]);

      expect(result.dataCompleteness.missingProtocols).toContain('Soroswap');
      expect(result.dataCompleteness.missingProtocols).toContain('DeFindex');
      expect(result.dataCompleteness.missingProtocols).not.toContain('Blend');
    });

    it('calculates total TVL correctly', () => {
      const availableData = [
        {
          protocol: 'Blend',
          tvlUsd: 12400000,
          poolCount: 50,
          avgDepthUsd: 248000,
          fetchedAt: new Date().toISOString(),
        },
        {
          protocol: 'Soroswap',
          tvlUsd: 4850000,
          poolCount: 30,
          avgDepthUsd: 161667,
          fetchedAt: new Date().toISOString(),
        },
      ];

      const aggregator = new MetricAggregator(mockYieldService);
      const result = aggregator.handlePartialData(availableData, ['Blend', 'Soroswap']);

      expect(result.totalTvlUsd).toBe(17250000);
    });
  });

  describe('polling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it.skip('starts polling at specified interval', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      
      // Start polling
      aggregator.startPolling(60000); // 1 minute

      // Run all pending timers (initial fetch)
      await jest.runAllTimersAsync();
      
      expect(mockYieldService.getYieldData).toHaveBeenCalled();

      aggregator.stopPolling();
    });

    it('throws error if polling already started', () => {
      const aggregator = new MetricAggregator(mockYieldService);
      aggregator.startPolling();

      expect(() => aggregator.startPolling()).toThrow(FragmentationError);
      expect(() => aggregator.startPolling()).toThrow('already started');

      aggregator.stopPolling();
    });

    it('stops polling when requested', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      aggregator.startPolling(60000);

      await jest.runOnlyPendingTimersAsync();
      const callCountBeforeStop = (mockYieldService.getYieldData as jest.Mock).mock.calls.length;

      aggregator.stopPolling();

      jest.advanceTimersByTime(120000); // 2 minutes
      await jest.runOnlyPendingTimersAsync();

      // Should not have made additional calls after stopping
      expect(mockYieldService.getYieldData).toHaveBeenCalledTimes(callCountBeforeStop);
    });
  });

  describe('cache management', () => {
    it('clears cache when requested', async () => {
      const mockData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
      ];

      (mockYieldService.getYieldData as jest.Mock).mockResolvedValue(mockData);

      const aggregator = new MetricAggregator(mockYieldService);
      await aggregator.aggregatePoolDepth();

      expect(aggregator.getCachedData()).not.toBeNull();

      aggregator.clearCache();

      expect(aggregator.getCachedData()).toBeNull();
    });
  });
});
