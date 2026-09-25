/**
 * Reusable failure-injection helpers for keeper integration tests.
 *
 * Provides jest mock factories that simulate external dependency failures
 * (Soroban RPC outage, timeouts, malformed responses) in keeper test suites.
 */

export type FailureMode =
  | 'connection_timeout'
  | 'outage'
  | 'malformed_json'
  | 'service_unavailable';

/**
 * Returns a partial Soroban rpc.Server mock simulating the given failure mode
 * across the contract data and event query surfaces used by VaultMonitor.
 */
export function mockSorobanRpc(mode: FailureMode): Record<string, jest.Mock> {
  switch (mode) {
    case 'connection_timeout':
      return {
        getContractData: jest.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Soroban RPC timeout')), 50)),
        ),
        getLatestLedger: jest.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Soroban RPC timeout')), 50)),
        ),
        simulateTransaction: jest.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Soroban RPC timeout')), 50)),
        ),
        sendTransaction: jest.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Soroban RPC timeout')), 50)),
        ),
      };

    case 'outage':
      return {
        getContractData: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
        getLatestLedger: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
        simulateTransaction: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
        sendTransaction: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
      };

    case 'malformed_json':
      return {
        getContractData: jest.fn(() => Promise.resolve({ entries: null })),
        getLatestLedger: jest.fn(() => Promise.resolve({ sequence: 'not-a-number' })),
        simulateTransaction: jest.fn(() => Promise.resolve({ error: 'malformed' })),
        sendTransaction: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
      };

    case 'service_unavailable':
      return {
        getContractData: jest.fn(() => Promise.reject(new Error('HTTP 503 Service Unavailable'))),
        getLatestLedger: jest.fn(() => Promise.reject(new Error('HTTP 503 Service Unavailable'))),
        simulateTransaction: jest.fn(() => Promise.reject(new Error('HTTP 503 Service Unavailable'))),
        sendTransaction: jest.fn(() => Promise.reject(new Error('HTTP 503 Service Unavailable'))),
      };
  }
}
