/**
 * Strategy Comparison Concurrency Client API (#1919)
 *
 * Provides optimistic concurrency control (OCC), version tracking, and safe retry
 * loops for strategy comparison workspace and strategy selection.
 */

import { apiUrl } from "../../lib/api";

export interface StrategyComparisonAssumptions {
  protocolFeeBps?: number;
  vaultFeeBps?: number;
  rebalanceCostBps?: number;
  slippageBps?: number;
}

export interface StrategyComparisonState {
  walletAddress: string;
  selectedStrategyId: string | null;
  pinnedStrategyIds: string[];
  customAssumptions: StrategyComparisonAssumptions;
  allocatedBalances: Record<string, number>;
  updatedAt: string;
  version: number;
}

export class StrategyComparisonConflictError extends Error {
  readonly code = "STRATEGY_COMPARISON_VERSION_CONFLICT";
  constructor(
    message: string,
    readonly currentVersion: number,
    readonly currentState: StrategyComparisonState,
  ) {
    super(message);
    this.name = "StrategyComparisonConflictError";
  }
}

function readVersionFromResponse(res: Response): number {
  const raw =
    res.headers.get("X-Comparison-Version") ??
    res.headers.get("ETag")?.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

const STRATEGIES_BASE = apiUrl("/api/strategies");

/**
 * Fetches the current strategy comparison workspace state and its version.
 */
export async function fetchComparisonStateVersioned(
  walletAddress: string,
): Promise<{ state: StrategyComparisonState; version: number }> {
  const res = await fetch(
    `${STRATEGIES_BASE}/comparison/state/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to fetch strategy comparison state");
  }

  const data = (await res.json()) as { state: StrategyComparisonState; version: number };
  const version = readVersionFromResponse(res) || data.version;
  return {
    state: data.state,
    version,
  };
}

export interface SaveComparisonOptions {
  expectedVersion?: number;
  operationIdentity?: string;
}

/**
 * Saves comparison workspace state with optimistic concurrency check.
 * If another writer updated state since expectedVersion, throws StrategyComparisonConflictError.
 */
export async function saveComparisonStateVersioned(
  walletAddress: string,
  state: Partial<StrategyComparisonState>,
  options: SaveComparisonOptions = {},
): Promise<{ state: StrategyComparisonState; version: number; isReplay?: boolean }> {
  const { expectedVersion, operationIdentity } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (operationIdentity) {
    headers["X-Operation-Identity"] = operationIdentity;
    headers["Idempotency-Key"] = operationIdentity;
  }
  if (expectedVersion !== undefined) {
    headers["If-Match"] = `"${expectedVersion}"`;
  }

  const res = await fetch(`${STRATEGIES_BASE}/comparison/state`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      walletAddress,
      ...state,
      expectedVersion,
      operationIdentity,
    }),
  });

  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
      expectedVersion?: number;
      currentVersion?: number;
      state?: StrategyComparisonState;
    };
    if (body.code === "STRATEGY_COMPARISON_VERSION_CONFLICT" && body.state) {
      throw new StrategyComparisonConflictError(
        body.error ?? "Strategy comparison state changed concurrently.",
        body.currentVersion ?? readVersionFromResponse(res),
        body.state,
      );
    }
    throw new Error(body.error ?? "Conflict updating strategy comparison state");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to update strategy comparison state");
  }

  const data = (await res.json()) as {
    state: StrategyComparisonState;
    version: number;
    isReplay?: boolean;
  };
  const version = readVersionFromResponse(res) || data.version;
  return {
    state: data.state,
    version,
    isReplay: data.isReplay,
  };
}

/**
 * Atomically selects a strategy and updates allocation under OCC.
 */
export async function selectStrategySafely(
  walletAddress: string,
  strategyId: string,
  allocationUsd: number,
  options: SaveComparisonOptions = {},
): Promise<{ state: StrategyComparisonState; version: number; isReplay?: boolean }> {
  const { expectedVersion, operationIdentity } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (operationIdentity) {
    headers["X-Operation-Identity"] = operationIdentity;
    headers["Idempotency-Key"] = operationIdentity;
  }
  if (expectedVersion !== undefined) {
    headers["If-Match"] = `"${expectedVersion}"`;
  }

  const res = await fetch(`${STRATEGIES_BASE}/comparison/select`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      walletAddress,
      strategyId,
      allocationUsd,
      expectedVersion,
      operationIdentity,
    }),
  });

  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
      currentVersion?: number;
      state?: StrategyComparisonState;
    };
    if (body.code === "STRATEGY_COMPARISON_VERSION_CONFLICT" && body.state) {
      throw new StrategyComparisonConflictError(
        body.error ?? "Strategy state changed concurrently.",
        body.currentVersion ?? readVersionFromResponse(res),
        body.state,
      );
    }
    throw new Error(body.error ?? "Conflict selecting strategy");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to select strategy");
  }

  const data = (await res.json()) as {
    state: StrategyComparisonState;
    version: number;
    isReplay?: boolean;
  };
  const version = readVersionFromResponse(res) || data.version;
  return {
    state: data.state,
    version,
    isReplay: data.isReplay,
  };
}

/**
 * Read-modify-write helper with automatic optimistic concurrency retry loop.
 * On conflict, reloads server's newer state and re-applies `changeFn` up to `maxAttempts`.
 */
export async function updateComparisonSafely(
  walletAddress: string,
  changeFn: (current: StrategyComparisonState) => Partial<StrategyComparisonState>,
  maxAttempts = 3,
): Promise<{ state: StrategyComparisonState; version: number }> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    const { state: current, version } = await fetchComparisonStateVersioned(walletAddress);
    const updates = changeFn(current);

    try {
      return await saveComparisonStateVersioned(walletAddress, updates, {
        expectedVersion: version,
        operationIdentity: `cmp-op-${walletAddress}-${version}-${attempt}-${Date.now()}`,
      });
    } catch (err) {
      if (err instanceof StrategyComparisonConflictError && attempt < maxAttempts) {
        // Retry loop reloads new state on next iteration
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to update strategy comparison after ${maxAttempts} attempts.`);
}

