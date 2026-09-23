import { WorkerOwnershipRegistry } from '../services/WorkerOwnershipRegistry';

describe('WorkerOwnershipRegistry', () => {
  let registry: WorkerOwnershipRegistry;

  beforeEach(() => {
    registry = new WorkerOwnershipRegistry(5000); // 5s TTL for tests
  });

  describe('claim', () => {
    it('allows first worker to claim a job', () => {
      expect(registry.claim('job-1', 'worker-a')).toBe(true);
      expect(registry.getOwner('job-1')?.workerId).toBe('worker-a');
    });

    it('rejects second worker while ownership is active', () => {
      registry.claim('job-1', 'worker-a');
      expect(registry.claim('job-1', 'worker-b')).toBe(false);
      expect(registry.getOwner('job-1')?.workerId).toBe('worker-a');
    });

    it('allows new worker after ownership expires', () => {
      registry.claim('job-1', 'worker-a');
      const ownership = registry.getOwner('job-1')!;
      ownership.heartbeatAt = Date.now() - 60_000; // expired

      expect(registry.claim('job-1', 'worker-b')).toBe(true);
      expect(registry.getOwner('job-1')?.workerId).toBe('worker-b');
    });

    it('refreshes heartbeat when same worker re-claims', () => {
      registry.claim('job-1', 'worker-a');
      const before = registry.getOwner('job-1')!.heartbeatAt;
      registry.claim('job-1', 'worker-a');
      expect(registry.getOwner('job-1')!.heartbeatAt).toBeGreaterThanOrEqual(before);
    });

    it('records handoff on first claim', () => {
      registry.claim('job-1', 'worker-a');
      const log = registry.getHandoffLog();
      expect(log).toHaveLength(1);
      expect(log[0].reason).toBe('normal');
      expect(log[0].toWorkerId).toBe('worker-a');
    });

    it('records handoff as expired when taking over', () => {
      registry.claim('job-1', 'worker-a');
      const ownership = registry.getOwner('job-1')!;
      ownership.heartbeatAt = Date.now() - 60_000;
      registry.claim('job-1', 'worker-b');

      const log = registry.getHandoffLog();
      expect(log).toHaveLength(2);
      expect(log[1].reason).toBe('expired');
      expect(log[1].fromWorkerId).toBe('worker-a');
      expect(log[1].toWorkerId).toBe('worker-b');
    });
  });

  describe('heartbeat', () => {
    it('updates heartbeat for owning worker', () => {
      registry.claim('job-1', 'worker-a');
      const before = registry.getOwner('job-1')!.heartbeatAt;
      registry.heartbeat('job-1', 'worker-a');
      expect(registry.getOwner('job-1')!.heartbeatAt).toBeGreaterThanOrEqual(before);
    });

    it('rejects heartbeat from non-owner', () => {
      registry.claim('job-1', 'worker-a');
      expect(registry.heartbeat('job-1', 'worker-b')).toBe(false);
    });

    it('rejects heartbeat for unclaimed job', () => {
      expect(registry.heartbeat('job-unknown', 'worker-a')).toBe(false);
    });
  });

  describe('release', () => {
    it('releases ownership for the correct worker', () => {
      registry.claim('job-1', 'worker-a');
      expect(registry.release('job-1', 'worker-a')).toBe(true);
      expect(registry.getOwner('job-1')).toBeUndefined();
    });

    it('rejects release from wrong worker', () => {
      registry.claim('job-1', 'worker-a');
      expect(registry.release('job-1', 'worker-b')).toBe(false);
      expect(registry.getOwner('job-1')).toBeDefined();
    });
  });

  describe('cleanupExpired', () => {
    it('removes expired ownerships', () => {
      registry.claim('job-1', 'worker-a');
      registry.claim('job-2', 'worker-b');
      const ownership1 = registry.getOwner('job-1')!;
      ownership1.heartbeatAt = Date.now() - 60_000;

      const cleaned = registry.cleanupExpired();
      expect(cleaned).toContain('job-1');
      expect(cleaned).not.toContain('job-2');
      expect(registry.getOwner('job-1')).toBeUndefined();
      expect(registry.getOwner('job-2')).toBeDefined();
    });
  });

  describe('registerRestart', () => {
    it('hands off jobs to restarted worker', () => {
      registry.claim('job-1', 'worker-old');
      registry.registerRestart('worker-new', ['job-1']);

      expect(registry.getOwner('job-1')?.workerId).toBe('worker-new');
      const log = registry.getHandoffLog();
      expect(log.some((h) => h.reason === 'restart' && h.fromWorkerId === 'worker-old')).toBe(true);
    });

    it('prevents duplicate worker pickup of same job', () => {
      registry.claim('job-1', 'worker-a');
      expect(registry.claim('job-1', 'worker-b')).toBe(false);
      expect(registry.getOwner('job-1')?.workerId).toBe('worker-a');
    });
  });

  describe('normal completion flow', () => {
    it('claim -> heartbeat -> release lifecycle', () => {
      expect(registry.claim('job-1', 'worker-a')).toBe(true);
      expect(registry.heartbeat('job-1', 'worker-a')).toBe(true);
      expect(registry.release('job-1', 'worker-a')).toBe(true);
      expect(registry.getOwner('job-1')).toBeUndefined();
    });
  });
});
