/**
 * Reusable failure-injection helpers for server integration tests.
 *
 * Each factory returns a jest.Mock configured to simulate a specific failure
 * class against an external dependency (Horizon, Soroban RPC, HTTP fetch).
 *
 * FailureMode variants:
 *   connection_timeout   — TCP-level hang: rejects after a short delay.
 *   outage               — Immediate rejection (ECONNREFUSED).
 *   malformed_json       — Response body is not valid JSON (SyntaxError on .json()).
 *   truncated_json       — Partial JSON body (connection dropped mid-stream).
 *   service_unavailable  — HTTP 503 with an empty body.
 */

export type FailureMode =
  | 'connection_timeout'
  | 'outage'
  | 'malformed_json'
  | 'truncated_json'
  | 'service_unavailable';

// ── HTTP fetch mocks ──────────────────────────────────────────────────────────

/**
 * Returns a jest.Mock that replaces global `fetch` and simulates the given failure.
 */
export function mockFetch(mode: FailureMode): jest.Mock {
  switch (mode) {
    case 'connection_timeout':
      return jest.fn(
        () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('connect ETIMEDOUT')), 50)),
      );
    case 'outage':
      return jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:80')));
    case 'malformed_json':
      return jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
          text: () => Promise.resolve('<html>Gateway Error</html>'),
        } as unknown as Response),
      );
    case 'truncated_json':
      return jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
          text: () => Promise.resolve('{"partial":'),
        } as unknown as Response),
      );
    case 'service_unavailable':
      return jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: () => Promise.resolve({ error: 'Service Unavailable' }),
        } as unknown as Response),
      );
  }
}

// ── Soroban RPC mocks ─────────────────────────────────────────────────────────

/**
 * Returns a partial Soroban RPC Server mock that simulates the given failure
 * on key methods used by the health check and indexer.
 */
export function mockSorobanRpc(mode: FailureMode): Record<string, jest.Mock> {
  switch (mode) {
    case 'connection_timeout':
      return {
        getLatestLedger: jest.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Soroban RPC timeout')), 50)),
        ),
        getEvents: jest.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Soroban RPC timeout')), 50)),
        ),
      };
    case 'outage':
      return {
        getLatestLedger: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
        getEvents: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
      };
    case 'malformed_json':
    case 'truncated_json':
      return {
        getLatestLedger: jest.fn(() => Promise.resolve({ sequence: 'not-a-number' })),
        getEvents: jest.fn(() => Promise.resolve({ events: null })),
      };
    case 'service_unavailable':
      return {
        getLatestLedger: jest.fn(() => Promise.reject(new Error('HTTP 503 Service Unavailable'))),
        getEvents: jest.fn(() => Promise.reject(new Error('HTTP 503 Service Unavailable'))),
      };
  }
}

// ── Horizon RPC mocks ─────────────────────────────────────────────────────────

/**
 * Returns a partial Horizon ledgers() chain mock for the given failure mode.
 * Intended to replace the return value of `new Horizon.Server()` in tests.
 */
export function mockHorizon(mode: FailureMode): Record<string, jest.Mock> {
  const callMock: jest.Mock = (() => {
    switch (mode) {
      case 'connection_timeout':
        return jest.fn(
          () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Horizon timeout')), 50)),
        );
      case 'outage':
        return jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
      case 'malformed_json':
      case 'truncated_json':
        return jest.fn(() => Promise.resolve({ records: [{ sequence: 'bad' }] }));
      case 'service_unavailable':
        return jest.fn(() => Promise.reject(new Error('HTTP 503 from Horizon')));
    }
  })();

  const chainMock = {
    ledgers: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        order: jest.fn().mockReturnValue({ call: callMock }),
      }),
    }),
    call: callMock,
  };

  return chainMock;
}
