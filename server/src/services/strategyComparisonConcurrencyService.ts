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

export interface StrategyComparisonOperationRecord {
  operationIdentity: string;
  result: StrategyComparisonState;
  createdAt: number;
}

export const STRATEGY_COMPARISON_VERSION_CONFLICT = "STRATEGY_COMPARISON_VERSION_CONFLICT";
export const INVALID_STRATEGY_COMPARISON_STATE = "INVALID_STRATEGY_COMPARISON_STATE";

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
// In-memory idempotency store indexed by operation identity
const comparisonOperationStore = new Map<string, StrategyComparisonOperationRecord>();

function normalizeWallet(wallet: string): string {
  return wallet.trim().toUpperCase();
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
}

/**
 * Updates comparison workspace state with optimistic concurrency control (OCC).
 *
 * Atomicity & Invariant Guarantees:
 * 1. Checks idempotency: if operationIdentity was already committed, replays previous result.
 * 2. Checks version: if expectedVersion does not match currentVersion, aborts with 409 conflict.
 * 3. Validates domain bounds: throws validation error on bad input; state is untouched.
 * 4. Executes update: bumps version and executes sideEffect atomically.
 * 5. Rollback on failure: if sideEffect throws, the previous state and version are restored.
 */
export function updateStrategyComparisonState(
  walletAddress: string,
  input: UpdateComparisonStateInput,
  options: UpdateComparisonStateOptions = {},
): { state: StrategyComparisonState; isReplay: boolean } {
  const normalized = normalizeWallet(walletAddress);
  const { expectedVersion, operationIdentity, sideEffect } = options;

  // 1. Idempotent deduplication check
  if (operationIdentity) {
    const existingOp = comparisonOperationStore.get(operationIdentity);
    if (existingOp) {
      return {
        state: JSON.parse(JSON.stringify(existingOp.result)),
        isReplay: true,
      };
    }
  }

  // 2. Read current state
  const current = getStrategyComparisonState(walletAddress);
  const currentVersion = current.version;

  // 3. Optimistic Concurrency Control guard
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new StrategyComparisonVersionConflictError(expectedVersion, currentVersion, current);
  }

  // 4. Validate input constraints (state preserved on validation failure)
  validateComparisonStateInput(input);

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

    // Record idempotency operation only after successful commit
    if (operationIdentity) {
      comparisonOperationStore.set(operationIdentity, {
        operationIdentity,
        result: JSON.parse(JSON.stringify(nextState)),
        createdAt: Date.now(),
      });
    }

    return {
      state: JSON.parse(JSON.stringify(nextState)),
      isReplay: false,
    };
  } catch (executionError) {
    // Atomic rollback to previous state and version
    if (previousStateSnapshot) {
      comparisonStateStore.set(normalized, previousStateSnapshot);
    } else {
      comparisonStateStore.delete(normalized);
    }
    throw executionError;
  }
}

/**
 * Select a strategy and atomically allocate balance under optimistic concurrency.
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
    options,
  );
}

