/**
 * Strategy Comparison Concurrency & State Management Service (#1919)
 *
 * Implements optimistic concurrency control (OCC), serialization, and atomic
 * state preservation for strategy comparison, selection, and allocation workspaces.
 */

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

export interface UpdateComparisonStateInput {
  selectedStrategyId?: string | null;
  pinnedStrategyIds?: string[];
  customAssumptions?: StrategyComparisonAssumptions;
  allocatedBalances?: Record<string, number>;
}

/**
 * Journal entry for one keyed operation (#1923).
 *
 * A committed entry is replayed when the same operation is retried. A failed
 * entry records that nothing was kept (the store was rolled back to
 * `baseVersion`), so the same key may be retried and will execute again.
 */
export type StrategyComparisonOperationRecord =
  | {
      operationIdentity: string;
      walletAddress: string;
      kind: StrategyComparisonOperationKind;
      requestFingerprint: string;
      status: "committed";
      baseVersion: number;
      result: StrategyComparisonState;
      createdAt: number;
      updatedAt: number;
      attempts: number;
    }
  | {
      operationIdentity: string;
      walletAddress: string;
      kind: StrategyComparisonOperationKind;
      requestFingerprint: string;
      status: "failed";
      baseVersion: number;
      errorCode: string;
      createdAt: number;
      updatedAt: number;
      attempts: number;
    };

export type StrategyComparisonOperationKind = "update" | "select";

export const STRATEGY_COMPARISON_VERSION_CONFLICT = "STRATEGY_COMPARISON_VERSION_CONFLICT";
export const INVALID_STRATEGY_COMPARISON_STATE = "INVALID_STRATEGY_COMPARISON_STATE";
export const STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH = "STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH";

/**
 * Thrown when an operation identity is reused for a different request. The
 * earlier outcome is not replayed and nothing is written (#1923).
 */
export class StrategyComparisonIdempotencyMismatchError extends Error {
  readonly code = STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH;
  constructor(readonly operationIdentity: string) {
    super(
      `Operation identity "${operationIdentity}" was already used for a different request. Use a new identity for a new change.`,
    );
    this.name = "StrategyComparisonIdempotencyMismatchError";
  }
}

/**
 * Thrown when an update specifies an expectedVersion that does not match the
 * stored record, indicating that another concurrent writer committed first.
 */
export class StrategyComparisonVersionConflictError extends Error {
  readonly code = STRATEGY_COMPARISON_VERSION_CONFLICT;
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
    readonly currentState: StrategyComparisonState,
  ) {
    super(
      `Strategy comparison state changed since version ${expectedVersion}; current version is ${currentVersion}. Reload and retry.`,
    );
    this.name = "StrategyComparisonVersionConflictError";
  }
}

/**
 * Thrown when proposed state updates violate domain boundary constraints.
 */
export class StrategyComparisonValidationError extends Error {
  readonly code = INVALID_STRATEGY_COMPARISON_STATE;
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "StrategyComparisonValidationError";
  }
}

// In-memory state store indexed by normalized wallet address
const comparisonStateStore = new Map<string, StrategyComparisonState>();
// In-memory operation journal, keyed by wallet + operation kind + identity so
// one wallet's key can never replay (or leak) another wallet's state.
const comparisonOperationStore = new Map<string, StrategyComparisonOperationRecord>();

function normalizeWallet(wallet: string): string {
  return wallet.trim().toUpperCase();
}

function operationKey(
  normalizedWallet: string,
  kind: StrategyComparisonOperationKind,
  operationIdentity: string,
): string {
  return JSON.stringify([normalizedWallet, kind, operationIdentity]);
}

/** Canonical JSON with sorted object keys, so equal requests fingerprint equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of the request an operation identity was first used for. */
export function fingerprintComparisonRequest(
  kind: StrategyComparisonOperationKind,
  request: unknown,
): string {
  return canonicalJson({ kind, request });
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : "STRATEGY_COMPARISON_EXECUTION_FAILED";
}

export type StrategyComparisonOperationStatus =
  | {
      status: "committed";
      operationIdentity: string;
      kind: StrategyComparisonOperationKind;
      baseVersion: number;
      version: number;
      state: StrategyComparisonState;
      attempts: number;
    }
  | {
      status: "failed";
      operationIdentity: string;
      kind: StrategyComparisonOperationKind;
      baseVersion: number;
      errorCode: string;
      attempts: number;
    };

/**
 * Look up what happened to a keyed operation, for a client that lost the
 * response (timeout, dropped connection) and must decide whether to retry.
 * `null` means the server never committed or recorded it: retrying with the
 * same identity is safe.
 */
export function getStrategyComparisonOperation(
  walletAddress: string,
  operationIdentity: string,
  kind?: StrategyComparisonOperationKind,
): StrategyComparisonOperationStatus | null {
  const normalized = normalizeWallet(walletAddress);
  const kinds: StrategyComparisonOperationKind[] = kind ? [kind] : ["update", "select"];
  for (const k of kinds) {
    const record = comparisonOperationStore.get(operationKey(normalized, k, operationIdentity));
    if (!record) continue;
    if (record.status === "committed") {
      return {
        status: "committed",
        operationIdentity,
        kind: record.kind,
        baseVersion: record.baseVersion,
        version: record.result.version,
        state: JSON.parse(JSON.stringify(record.result)),
        attempts: record.attempts,
      };
    }
    return {
      status: "failed",
      operationIdentity,
      kind: record.kind,
      baseVersion: record.baseVersion,
      errorCode: record.errorCode,
      attempts: record.attempts,
    };
  }
  return null;
}

/** Default initial comparison workspace state for a new wallet */
export function createDefaultComparisonState(walletAddress: string): StrategyComparisonState {
  return {
    walletAddress: normalizeWallet(walletAddress),
    selectedStrategyId: null,
    pinnedStrategyIds: [],
    customAssumptions: {},
    allocatedBalances: {},
    updatedAt: new Date().toISOString(),
    version: 0,
  };
}

/** Reset in-memory stores for clean test isolation */
export function resetComparisonStateStore(): void {
  comparisonStateStore.clear();
}

export function clearComparisonOperationStore(): void {
  comparisonOperationStore.clear();
}

/** Retrieve current comparison workspace state and its version (0 if none) */
export function getStrategyComparisonState(walletAddress: string): StrategyComparisonState {
  const normalized = normalizeWallet(walletAddress);
  const existing = comparisonStateStore.get(normalized);
  if (existing) {
    // Return structured clone to prevent external mutation
    return JSON.parse(JSON.stringify(existing));
  }
  return createDefaultComparisonState(walletAddress);
}

/** Retrieve current version number for a wallet (0 if uninitialized) */
export function getStrategyComparisonVersion(walletAddress: string): number {
  const normalized = normalizeWallet(walletAddress);
  return comparisonStateStore.get(normalized)?.version ?? 0;
}

/**
 * Validates domain constraints on proposed comparison state:
 * - Fee basis points must be within [0, 10,000]
 * - Balance allocations must be finite non-negative numbers
 */
export function validateComparisonStateInput(input: UpdateComparisonStateInput): void {
  if (input.customAssumptions) {
    const fees = Object.entries(input.customAssumptions) as Array<[string, number | undefined]>;
    for (const [key, val] of fees) {
      if (val !== undefined) {
        if (!Number.isFinite(val) || val < 0 || val > 10000) {
          throw new StrategyComparisonValidationError(
            `Assumption ${key} must be a finite number between 0 and 10,000 bps. Received: ${val}`,
            { field: key, value: val },
          );
        }
      }
    }
  }

  if (input.allocatedBalances) {
    for (const [strategyId, balance] of Object.entries(input.allocatedBalances)) {
      if (!Number.isFinite(balance) || balance < 0) {
        throw new StrategyComparisonValidationError(
          `Allocated balance for ${strategyId} must be a non-negative finite number. Received: ${balance}`,
          { strategyId, balance },
        );
      }
    }
  }
}

export interface UpdateComparisonStateOptions {
  expectedVersion?: number;
  operationIdentity?: string;
  sideEffect?: (next: StrategyComparisonState, previous: StrategyComparisonState) => void;
  /** Journal namespace for operationIdentity; defaults to "update". */
  operationKind?: StrategyComparisonOperationKind;
  /**
   * What the caller asked for, used to detect a reused identity. Defaults to
   * the update input. Callers that derive the input from current state (such
   * as select) pass their own request so a retry matches the original.
   */
  requestFingerprint?: string;
}

/**
 * Updates comparison workspace state with optimistic concurrency control (OCC).
 *
 * Atomicity, invariant and retry guarantees:
 * 1. Idempotency: an operationIdentity already committed for this wallet is
 *    replayed, not re-applied, even if other writers moved the version since.
 *    Reusing an identity for a different request is refused (#1923).
 * 2. Version: if expectedVersion does not match currentVersion, aborts with a
 *    409 conflict.
 * 3. Validation: bad input throws; state is untouched.
 * 4. Execution: bumps version and runs sideEffect.
 * 5. Rollback: if sideEffect throws, the previous state and version are
 *    restored.
 * 6. Journal: every outcome of a keyed operation is recorded. A failed
 *    attempt is recorded with the version the store was left at, so a client
 *    can tell that nothing was kept and retry the same identity.
 */
export function updateStrategyComparisonState(
  walletAddress: string,
  input: UpdateComparisonStateInput,
  options: UpdateComparisonStateOptions = {},
): { state: StrategyComparisonState; isReplay: boolean } {
  const normalized = normalizeWallet(walletAddress);
  const { expectedVersion, operationIdentity, sideEffect } = options;
  const kind = options.operationKind ?? "update";
  const requestFingerprint =
    options.requestFingerprint ?? fingerprintComparisonRequest(kind, input);
  const journalKey = operationIdentity ? operationKey(normalized, kind, operationIdentity) : null;
  const priorRecord = journalKey ? comparisonOperationStore.get(journalKey) : undefined;

  // 1. Idempotent deduplication check
  if (priorRecord) {
    if (priorRecord.requestFingerprint !== requestFingerprint) {
      throw new StrategyComparisonIdempotencyMismatchError(priorRecord.operationIdentity);
    }
    if (priorRecord.status === "committed") {
      return {
        state: JSON.parse(JSON.stringify(priorRecord.result)),
        isReplay: true,
      };
    }
    // A failed attempt kept nothing; fall through and execute it again.
  }

  // 2. Read current state
  const current = getStrategyComparisonState(walletAddress);
  const currentVersion = current.version;
  const attempts = (priorRecord?.attempts ?? 0) + 1;
  const createdAt = priorRecord?.createdAt ?? Date.now();

  const recordFailure = (error: unknown): void => {
    if (!journalKey || !operationIdentity) return;
    comparisonOperationStore.set(journalKey, {
      operationIdentity,
      walletAddress: normalized,
      kind,
      requestFingerprint,
      status: "failed",
      baseVersion: currentVersion,
      errorCode: errorCodeOf(error),
      createdAt,
      updatedAt: Date.now(),
      attempts,
    });
  };

  // 3. Optimistic Concurrency Control guard
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    const conflict = new StrategyComparisonVersionConflictError(expectedVersion, currentVersion, current);
    recordFailure(conflict);
    throw conflict;
  }

  // 4. Validate input constraints (state preserved on validation failure)
  try {
    validateComparisonStateInput(input);
  } catch (validationError) {
    recordFailure(validationError);
    throw validationError;
  }

  // 5. Compute new state with incremented version
  const nextVersion = currentVersion + 1;
  const nextState: StrategyComparisonState = {
    walletAddress: normalized,
    selectedStrategyId:
      input.selectedStrategyId !== undefined
        ? input.selectedStrategyId
        : current.selectedStrategyId,
    pinnedStrategyIds: input.pinnedStrategyIds
      ? [...input.pinnedStrategyIds]
      : [...current.pinnedStrategyIds],
    customAssumptions: input.customAssumptions
      ? { ...input.customAssumptions }
      : { ...current.customAssumptions },
    allocatedBalances: input.allocatedBalances
      ? { ...input.allocatedBalances }
      : { ...current.allocatedBalances },
    updatedAt: new Date().toISOString(),
    version: nextVersion,
  };

  // 6. Pre-commit state backup for atomic rollback if sideEffect fails
  const previousStateSnapshot = comparisonStateStore.get(normalized);

  try {
    // Apply update to store
    comparisonStateStore.set(normalized, nextState);

    // Run synchronous side effect (e.g. audit or balance execution)
    if (sideEffect) {
      sideEffect(nextState, current);
    }
  } catch (executionError) {
    // Atomic rollback to previous state and version
    if (previousStateSnapshot) {
      comparisonStateStore.set(normalized, previousStateSnapshot);
    } else {
      comparisonStateStore.delete(normalized);
    }
    recordFailure(executionError);
    throw executionError;
  }

  // Record the committed outcome so a retry replays it instead of re-applying.
  if (journalKey && operationIdentity) {
    comparisonOperationStore.set(journalKey, {
      operationIdentity,
      walletAddress: normalized,
      kind,
      requestFingerprint,
      status: "committed",
      baseVersion: currentVersion,
      result: JSON.parse(JSON.stringify(nextState)),
      createdAt,
      updatedAt: Date.now(),
      attempts,
    });
  }

  return {
    state: JSON.parse(JSON.stringify(nextState)),
    isReplay: false,
  };
}

/**
 * Select a strategy and atomically allocate balance under optimistic concurrency.
 *
 * The journal fingerprint is the caller's request (strategy and amount), not
 * the derived balances, so a retry after other writes still matches and
 * replays the original outcome.
 */
export function selectStrategyAndAllocate(
  walletAddress: string,
  strategyId: string,
  allocationUsd: number,
  options: UpdateComparisonStateOptions = {},
): { state: StrategyComparisonState; isReplay: boolean } {
  const current = getStrategyComparisonState(walletAddress);
  const updatedBalances = {
    ...current.allocatedBalances,
    [strategyId]: allocationUsd,
  };

  return updateStrategyComparisonState(
    walletAddress,
    {
      selectedStrategyId: strategyId,
      allocatedBalances: updatedBalances,
    },
    {
      ...options,
      operationKind: "select",
      requestFingerprint: fingerprintComparisonRequest("select", { strategyId, allocationUsd }),
    },
  );
}
