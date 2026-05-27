import { RecoveryPriorityQueueService, RecoveryItem } from '../recoveryPriorityQueueService';

function makeItem(id: string, overrides: Partial<RecoveryItem> = {}): RecoveryItem {
  return {
    id,
    strategyId: `strat-${id}`,
    impactScore: 0.5,
    userExposure: 100,
    riskSeverity: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('RecoveryPriorityQueueService', () => {
  let svc: RecoveryPriorityQueueService;
  beforeEach(() => { svc = new RecoveryPriorityQueueService(); });

  it('ranks critical/high-impact items first', () => {
    svc.enqueue(makeItem('low', { impactScore: 0.1, riskSeverity: 'low' }));
    svc.enqueue(makeItem('crit', { impactScore: 0.9, riskSeverity: 'critical' }));
    svc.enqueue(makeItem('med', { impactScore: 0.5, riskSeverity: 'medium' }));
    const queue = svc.getRankedQueue();
    expect(queue[0].id).toBe('crit');
    expect(queue[queue.length - 1].id).toBe('low');
  });

  it('high user exposure increases priority', () => {
    svc.enqueue(makeItem('A', { userExposure: 1000, riskSeverity: 'medium' }));
    svc.enqueue(makeItem('B', { userExposure: 10, riskSeverity: 'medium' }));
    const queue = svc.getRankedQueue();
    expect(queue[0].id).toBe('A');
  });

  it('reprioritize records change log entry', () => {
    svc.enqueue(makeItem('X', { impactScore: 0.2 }));
    svc.enqueue(makeItem('Y', { impactScore: 0.8 }));
    svc.reprioritize('X', 0.95, 'Operator escalation: fund risk detected');
    const log = svc.getChangeLog();
    expect(log).toHaveLength(1);
    expect(log[0].itemId).toBe('X');
    expect(log[0].reason).toContain('Operator escalation');
    expect(log[0].newRank).toBe(1);
  });

  it('assigns sequential ranks starting at 1', () => {
    svc.enqueue(makeItem('A'));
    svc.enqueue(makeItem('B'));
    svc.enqueue(makeItem('C'));
    const ranks = svc.getRankedQueue().map((i) => i.rank);
    expect(ranks).toEqual([1, 2, 3]);
  });

  it('critical item is never starved behind noisier low-impact items', () => {
    for (let i = 0; i < 10; i++) {
      svc.enqueue(makeItem(`noise-${i}`, { impactScore: 0.3, riskSeverity: 'low', userExposure: 500 }));
    }
    svc.enqueue(makeItem('critical', { impactScore: 0.9, riskSeverity: 'critical', userExposure: 50 }));
    expect(svc.getRankedQueue()[0].id).toBe('critical');
  });
});
