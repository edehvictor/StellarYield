// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock ioredis so queue/event creation doesn't try to connect
jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    status: 'ready',
  })),
}));

// Mock BullMQ to avoid real Redis connections
jest.mock('bullmq', () => {
  const mockAdd = jest.fn().mockResolvedValue({ id: 'j1' });
  const mockRemoveRepeatable = jest.fn().mockResolvedValue(undefined);
  const mockClose = jest.fn().mockResolvedValue(undefined);
  const mockOn = jest.fn();

  return {
    Queue: jest.fn().mockImplementation((name: string) => ({
      name,
      add: mockAdd,
      removeRepeatable: mockRemoveRepeatable,
      close: mockClose,
    })),
    QueueEvents: jest.fn().mockImplementation((name: string) => ({
      name,
      on: mockOn,
    })),
    _mockAdd: mockAdd,
    _mockOn: mockOn,
  };
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('queues/index', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('createLiquidationQueue() creates a BullMQ Queue named "liquidation"', () => {
    const { createLiquidationQueue } = require('../queues');
    const { Queue } = require('bullmq');
    const q = createLiquidationQueue();
    expect(Queue).toHaveBeenCalledWith(
      'liquidation',
      expect.objectContaining({ defaultJobOptions: expect.any(Object) }),
    );
    expect(q.name).toBe('liquidation');
  });

  test('createCompoundQueue() creates a BullMQ Queue named "compound"', () => {
    const { createCompoundQueue } = require('../queues');
    const { Queue } = require('bullmq');
    const q = createCompoundQueue();
    expect(Queue).toHaveBeenCalledWith(
      'compound',
      expect.objectContaining({ defaultJobOptions: expect.any(Object) }),
    );
    expect(q.name).toBe('compound');
  });

  test('default job options include exponential backoff and attempt limit', () => {
    const { createLiquidationQueue } = require('../queues');
    const { Queue } = require('bullmq');
    createLiquidationQueue();
    const [, opts] = Queue.mock.calls[0];
    expect(opts.defaultJobOptions).toMatchObject({
      attempts: expect.any(Number),
      backoff: { type: 'exponential', delay: expect.any(Number) },
      removeOnComplete: expect.any(Object),
      removeOnFail: expect.any(Object),
    });
  });

  test('attachQueueEvents() returns a QueueEvents instance', () => {
    const { attachQueueEvents } = require('../queues');
    const { QueueEvents } = require('bullmq');
    const events = attachQueueEvents('liquidation');
    expect(QueueEvents).toHaveBeenCalledWith('liquidation', expect.any(Object));
    expect(events).toBeDefined();
  });

  test('attachQueueEvents() registers completed, failed, and stalled listeners', () => {
    const { attachQueueEvents } = require('../queues');
    const { QueueEvents } = require('bullmq');
    attachQueueEvents('compound');
    const instance = QueueEvents.mock.results[0].value;
    expect(instance.on).toHaveBeenCalledWith('completed', expect.any(Function));
    expect(instance.on).toHaveBeenCalledWith('failed', expect.any(Function));
    expect(instance.on).toHaveBeenCalledWith('stalled', expect.any(Function));
  });
});

describe('queues/types', () => {
  test('QUEUE_NAMES has LIQUIDATION and COMPOUND entries', () => {
    const { QUEUE_NAMES } = require('../queues/types');
    expect(QUEUE_NAMES.LIQUIDATION).toBe('liquidation');
    expect(QUEUE_NAMES.COMPOUND).toBe('compound');
  });
});
