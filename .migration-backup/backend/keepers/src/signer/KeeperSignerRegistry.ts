import { logger } from '../utils/logger';
import type { SignerProvider } from './SignerProvider';

/**
 * Holds the "currently active" signer provider so it can be rotated without
 * restarting workers. Workers should read `currentProvider` fresh at the top
 * of each job's `process()` call (not cache it in a constructor field) — that
 * way an in-flight invocation keeps using the provider it was dispatched
 * with, while the *next* job picks up whatever `rotate()` most recently set.
 */
export class KeeperSignerRegistry {
  private current: SignerProvider;

  constructor(initialProvider: SignerProvider) {
    this.current = initialProvider;
  }

  get currentProvider(): SignerProvider {
    return this.current;
  }

  /** Swaps the active provider. Never logs key material — only provider ids. */
  rotate(newProvider: SignerProvider, reason?: string): void {
    const oldProviderId = this.current.id;
    this.current = newProvider;
    logger.info(
      {
        oldProviderId,
        newProviderId: newProvider.id,
        reason: reason ?? 'unspecified',
        rotatedAt: new Date().toISOString(),
      },
      '[KeeperSignerRegistry] Signer rotated',
    );
  }
}
