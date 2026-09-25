import { StrategyCandidateQueueService, type StrategyCandidate } from '../services/strategyCandidateQueueService';

describe('StrategyCandidateQueueService', () => {
  let service: StrategyCandidateQueueService;

  const highQualityCandidate: StrategyCandidate = {
    id: 'candidate-1',
    name: 'Blend USDC High Yield',
    strategyType: 'lending',
    expectedUpsidePct: 25,
    confidenceScore: 90,
    urgencyScore: 80,
    resourceCost: 100,
    createdAt: new Date().toISOString(),
  };

  const mediumQualityCandidate: StrategyCandidate = {
    id: 'candidate-2',
    name: 'Soroswap LP',
    strategyType: 'dex-lp',
    expectedUpsidePct: 12,
    confidenceScore: 70,
    urgencyScore: 50,
    resourceCost: 80,
    createdAt: new Date().toISOString(),
  };

  const lowQualityCandidate: StrategyCandidate = {
    id: 'candidate-3',
    name: 'Speculative Farm',
    strategyType: 'farm',
    expectedUpsidePct: 2,
    confidenceScore: 10,
    urgencyScore: 5,
    resourceCost: 200,
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    service = new StrategyCandidateQueueService();
  });

  describe('queue ordering', () => {
    it('should rank higher priority candidates first', () => {
      service.enqueue(mediumQualityCandidate);
      service.enqueue(highQualityCandidate);
      service.enqueue(lowQualityCandidate);

      const queue = service.getPrioritizedQueue();

      expect(queue.length).toBe(3);
      expect(queue[0].id).toBe('candidate-1');
      expect(queue[1].id).toBe('candidate-2');
      expect(queue[2].id).toBe('candidate-3');
    });

    it('should compute priority scores correctly', () => {
      service.enqueue(highQualityCandidate);
      const queue = service.getPrioritizedQueue();

      expect(queue[0].priorityScore).toBeGreaterThan(0);
      expect(queue[0].rank).toBe(1);
    });

    it('should provide meaningful justifications', () => {
      service.enqueue(highQualityCandidate);
      const queue = service.getPrioritizedQueue();

      expect(queue[0].justification).toContain('high upside');
      expect(queue[0].justification).toContain('strong confidence');
      expect(queue[0].justification).toContain('urgent');
    });
  });

  describe('starvation prevention', () => {
    it('should track starvation count', () => {
      const starvationConfig = {
        starvationPreventionEnabled: true,
        starvationTimeToLiveMs: 0,
        maxQueueSize: 100,
      };

      service = new StrategyCandidateQueueService(starvationConfig);
      service.enqueue(mediumQualityCandidate);
      service.enqueue(highQualityCandidate);

      const queue = service.getPrioritizedQueue();
      const state = service.getQueueState();

      expect(state.starvationCount).toBeGreaterThanOrEqual(0);
      expect(queue.length).toBe(2);
    });

    it('should prevent low-quality candidates from blocking queue', () => {
      for (let i = 0; i < 10; i++) {
        service.enqueue({
          id: `low-quality-${i}`,
          name: `Low Quality ${i}`,
          strategyType: 'farm',
          expectedUpsidePct: 1,
          confidenceScore: 5,
          urgencyScore: 3,
          resourceCost: 100,
          createdAt: new Date().toISOString(),
        });
      }

      const added = service.enqueue(highQualityCandidate);
      expect(added).toBe(true);

      const queue = service.getPrioritizedQueue();
      expect(queue[0].id).toBe(highQualityCandidate.id);
    });

    it('should reject low-quality candidates when queue is full', () => {
      const smallQueue = new StrategyCandidateQueueService({ maxQueueSize: 3 });

      smallQueue.enqueue(highQualityCandidate);
      smallQueue.enqueue(mediumQualityCandidate);
      smallQueue.enqueue({
        id: 'candidate-4',
        name: 'Another',
        strategyType: 'lending',
        expectedUpsidePct: 15,
        confidenceScore: 80,
        urgencyScore: 60,
        resourceCost: 90,
        createdAt: new Date().toISOString(),
      });

      const rejected = smallQueue.enqueue(lowQualityCandidate);
      expect(rejected).toBe(false);
    });
  });

  describe('processing pipeline', () => {
    it('should return next candidate for processing', () => {
      service.enqueue(highQualityCandidate);
      const next = service.nextForProcessing();

      expect(next).not.toBeNull();
      expect(next!.id).toBe(highQualityCandidate.id);
    });

    it('should approve high quality candidates', () => {
      service.enqueue(highQualityCandidate);
      const result = service.approve(highQualityCandidate.id);

      expect(result.approved).toBe(true);
      expect(result.reason).toContain('approved');
    });

    it('should reject low quality candidates', () => {
      service.enqueue(lowQualityCandidate);
      const result = service.approve(lowQualityCandidate.id);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('below minimum');
    });

    it('should allow explicit rejection with reason', () => {
      service.enqueue(highQualityCandidate);
      const result = service.reject(highQualityCandidate.id, 'Manual override by operator');

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Manual override by operator');
    });

    it('should return null when queue is empty', () => {
      const next = service.nextForProcessing();
      expect(next).toBeNull();
    });

    it('should return failure for non-existent candidate approval', () => {
      const result = service.approve('non-existent');
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('not found');
    });
  });

  describe('queue state tracking', () => {
    it('should track total enqueued and processed', () => {
      service.enqueue(highQualityCandidate);
      service.enqueue(mediumQualityCandidate);

      service.approve(highQualityCandidate.id);

      const state = service.getQueueState();
      expect(state.totalEnqueued).toBe(2);
      expect(state.totalProcessed).toBe(1);
      expect(state.currentQueueSize).toBe(1);
    });

    it('should prevent duplicate enqueue', () => {
      const first = service.enqueue(highQualityCandidate);
      const second = service.enqueue(highQualityCandidate);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });

  describe('candidate qualification', () => {
    it('should qualify high quality candidates', () => {
      expect(service.isCandidateQualified(highQualityCandidate)).toBe(true);
    });

    it('should disqualify low quality candidates', () => {
      expect(service.isCandidateQualified(lowQualityCandidate)).toBe(false);
    });
  });

  describe('config updates', () => {
    it('should allow config updates', () => {
      service.updateConfig({ minPriorityToProcess: 20, upsideWeight: 0.5 });
      const config = service.getConfig();
      expect(config.minPriorityToProcess).toBe(20);
      expect(config.upsideWeight).toBe(0.5);
    });
  });

  describe('clear', () => {
    it('should clear all candidates', () => {
      service.enqueue(highQualityCandidate);
      service.enqueue(mediumQualityCandidate);

      service.clear();

      expect(service.getQueueState().currentQueueSize).toBe(0);
      expect(service.getPrioritizedQueue().length).toBe(0);
    });
  });
});
