jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { KeeperSignerRegistry } from '../signer/KeeperSignerRegistry';
import { logger } from '../utils/logger';
import type { SignerProvider } from '../signer/SignerProvider';

function fakeProvider(id: string, publicKey: string): SignerProvider {
  return {
    id,
    publicKey,
    allowedOperations: new Set(['harvest', 'liquidate']),
    sign: jest.fn().mockResolvedValue({} as any),
  };
}

describe('KeeperSignerRegistry', () => {
  test('currentProvider returns the initial provider', () => {
    const providerA = fakeProvider('local:GAAA', 'GAAA');
    const registry = new KeeperSignerRegistry(providerA);
    expect(registry.currentProvider).toBe(providerA);
  });

  test('rotate() swaps the active provider for subsequent reads', () => {
    const providerA = fakeProvider('local:GAAA', 'GAAA');
    const providerB = fakeProvider('local:GBBB', 'GBBB');
    const registry = new KeeperSignerRegistry(providerA);

    registry.rotate(providerB, 'scheduled key rotation');

    expect(registry.currentProvider).toBe(providerB);
  });

  test('a job that already captured the pre-rotation provider keeps using it; only new reads see the rotated provider', () => {
    const providerA = fakeProvider('local:GAAA', 'GAAA');
    const providerB = fakeProvider('local:GBBB', 'GBBB');
    const registry = new KeeperSignerRegistry(providerA);

    // Simulate a job dispatched before rotation: it captures the provider
    // reference at dispatch time, exactly as a worker's process() should.
    const inFlightProvider = registry.currentProvider;

    registry.rotate(providerB, 'rotation mid-flight');

    // The in-flight job's captured reference is unaffected by the rotation.
    expect(inFlightProvider).toBe(providerA);
    expect(inFlightProvider.publicKey).toBe('GAAA');

    // A new job dispatched after rotation reads the rotated provider.
    const nextJobProvider = registry.currentProvider;
    expect(nextJobProvider).toBe(providerB);
    expect(nextJobProvider.publicKey).toBe('GBBB');
  });

  test('rotate() logs only non-secret provider ids, never key material', () => {
    const providerA = fakeProvider('local:GAAA', 'GAAA');
    const providerB = fakeProvider('local:GBBB', 'GBBB');
    const registry = new KeeperSignerRegistry(providerA);

    registry.rotate(providerB, 'manual rotation');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ oldProviderId: 'local:GAAA', newProviderId: 'local:GBBB' }),
      expect.any(String),
    );

    const loggedPayload = JSON.stringify((logger.info as jest.Mock).mock.calls[0]);
    expect(loggedPayload).not.toContain('S' + 'A'.repeat(55));
  });
});
