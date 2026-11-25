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
  /**
   * Identity of this logical change. Every retry of the same change reuses
   * it, so the server replays a write it already kept instead of applying it
   * twice. One is generated when omitted.
   */
  operationIdentity?: string;
  /** Extra sends after a lost response (network error or 5xx). Default 2. */
  transportRetries?: number;
  /** Delay before each transport retry, in ms. Default 250, then 750. */
  retryDelaysMs?: readonly number[];
}

/**
 * Thrown when the server refuses an operation identity that was already used
 * for a different change (#1923). Nothing was written; the caller must use a
 * new identity for a new change.
 */
export class StrategyComparisonIdempotencyMismatchError extends Error {
  readonly code = "STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH";
  constructor(message: string, readonly operationIdentity: string) {
    super(message);
    this.name = "StrategyComparisonIdempotencyMismatchError";
  }
}

/**
 * Backward-compatible name retained for clients created for #1920.
 */
export class StrategyComparisonOperationIdentityConflictError extends StrategyComparisonIdempotencyMismatchError {
  readonly code = "STRATEGY_COMPARISON_OPERATION_IDENTITY_CONFLICT";
  constructor(message: string, operationIdentity = "") {
    super(message, operationIdentity);
    this.name = "StrategyComparisonOperationIdentityConflictError";
  }
}

/**
 * Thrown when a write could not be confirmed after every transport retry.
 * The server may or may not have kept it: resolve with
 * `fetchComparisonOperation(walletAddress, operationIdentity)`, or send the
 * same change again with the same identity, which is always safe.
 */
export class StrategyComparisonOutcomeUnknownError extends Error {
  readonly code = "STRATEGY_COMPARISON_OUTCOME_UNKNOWN";
  constructor(message: string, readonly operationIdentity: string) {
    super(message);
    this.name = "StrategyComparisonOutcomeUnknownError";
  }
}

const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const;

/** A fresh operation identity for one logical change. */
export function newComparisonOperationIdentity(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return `cmp-${cryptoApi.randomUUID()}`;
  return `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

type ComparisonWriteResult = { state: StrategyComparisonState; version: number; isReplay?: boolean };

/**
 * Sends one keyed write, resending the same request with the same identity
 * when the response is lost. A 409, 422 or 4xx is final and never resent.
 */
async function sendComparisonWrite(
  path: string,
  method: "PUT" | "POST",
  body: Record<string, unknown>,
  options: SaveComparisonOptions,
  fallbackMessages: { conflict: string; failure: string },
): Promise<ComparisonWriteResult> {
  const { expectedVersion } = options;
  const operationIdentity = options.operationIdentity ?? newComparisonOperationIdentity();
  const transportRetries = Math.max(0, options.transportRetries ?? 2);
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Operation-Identity": operationIdentity,
    "Idempotency-Key": operationIdentity,
  };
  if (expectedVersion !== undefined) {
    headers["If-Match"] = `"${expectedVersion}"`;
  }
  const payload = JSON.stringify({ ...body, expectedVersion, operationIdentity });

  let lastFailure = "";
  for (let attempt = 0; attempt <= transportRetries; attempt++) {
    if (attempt > 0) await wait(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);

    let res: Response;
    try {
      res = await fetch(`${STRATEGIES_BASE}${path}`, { method, headers, body: payload });
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
      continue;
    }

    if (res.status >= 500) {
      const failed = (await res.json().catch(() => ({}))) as { error?: string };
      lastFailure = failed.error ?? `HTTP ${res.status}`;
      continue;
    }

    if (res.status === 409) {
      const conflict = (await res.json().catch(() => ({}))) as {
        code?: string;
        error?: string;
        currentVersion?: number;
        state?: StrategyComparisonState;
      };
      if (
        conflict.code === "STRATEGY_COMPARISON_OPERATION_IDENTITY_CONFLICT" ||
        conflict.code === "STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH"
      ) {
        throw new StrategyComparisonOperationIdentityConflictError(
          conflict.error ?? "Operation identity was already used for a different comparison update.",
        );
      }
      if (conflict.code === "STRATEGY_COMPARISON_VERSION_CONFLICT" && conflict.state) {
        throw new StrategyComparisonConflictError(
          conflict.error ?? fallbackMessages.conflict,
          conflict.currentVersion ?? readVersionFromResponse(res),
          conflict.state,
        );
      }
      throw new Error(conflict.error ?? fallbackMessages.conflict);
    }

    if (!res.ok) {
      const failed = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (failed.code === "STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH") {
        throw new StrategyComparisonOperationIdentityConflictError(
          failed.error ?? "Operation identity was already used for a different change.",
          operationIdentity,
        );
      }
      throw new Error(failed.error ?? fallbackMessages.failure);
    }

    const data = (await res.json()) as ComparisonWriteResult;
    const version = readVersionFromResponse(res) || data.version;
    return { state: data.state, version, isReplay: data.isReplay };
  }

  throw new StrategyComparisonOutcomeUnknownError(
    `${fallbackMessages.failure} (${lastFailure || "no response"}). Your previous workspace is unchanged unless the server confirms this change; retrying is safe.`,
    operationIdentity,
  );
}

/**
 * Saves comparison workspace state with optimistic concurrency check.
 * If another writer updated state since expectedVersion, throws StrategyComparisonConflictError.
 * A lost response is resent with the same identity (#1923).
 */
export async function saveComparisonStateVersioned(
  walletAddress: string,
  state: Partial<StrategyComparisonState>,
  options: SaveComparisonOptions = {},
): Promise<ComparisonWriteResult> {
  return sendComparisonWrite(
    "/comparison/state",
    "PUT",
    { walletAddress, ...state },
    options,
    {
      conflict: "Strategy comparison state changed concurrently.",
      failure: "Failed to update strategy comparison state",
    },
  );
}

/**
 * Atomically selects a strategy and updates allocation under OCC.
 * A lost response is resent with the same identity (#1923).
 */
export async function selectStrategySafely(
  walletAddress: string,
  strategyId: string,
  allocationUsd: number,
  options: SaveComparisonOptions = {},
): Promise<ComparisonWriteResult> {
  return sendComparisonWrite(
    "/comparison/select",
    "POST",
    { walletAddress, strategyId, allocationUsd },
    options,
    {
      conflict: "Strategy state changed concurrently.",
      failure: "Failed to select strategy",
    },
  );
}

export type ComparisonOperationStatus =
  | {
      status: "committed";
      operationIdentity: string;
      kind: "update" | "select";
      baseVersion: number;
      version: number;
      state: StrategyComparisonState;
      attempts: number;
    }
  | {
      status: "failed";
      operationIdentity: string;
      kind: "update" | "select";
      baseVersion: number;
      errorCode: string;
      attempts: number;
    }
  | { status: "unknown"; operationIdentity: string };

/**
 * Asks the server what happened to a keyed write whose response was lost.
 * `committed`: the change is kept. `failed` or `unknown`: nothing was kept and
 * sending the same change with the same identity is safe.
 */
export async function fetchComparisonOperation(
  walletAddress: string,
  operationIdentity: string,
): Promise<ComparisonOperationStatus> {
  const res = await fetch(
    `${STRATEGIES_BASE}/comparison/operations/${encodeURIComponent(walletAddress)}/${encodeURIComponent(operationIdentity)}`,
  );
  if (res.status === 404) return { status: "unknown", operationIdentity };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to look up strategy comparison operation");
  }
  return (await res.json()) as ComparisonOperationStatus;
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
        // A new identity per attempt: after a conflict the change is
        // recomputed against newer state, so it is a different request.
        operationIdentity: newComparisonOperationIdentity(),
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

