/**
 * Strategy Comparison Concurrency & State Management Service
 * (#1919, #1925)
 *
 * Implements optimistic concurrency control, privacy-safe diagnostics,
 * input validation, and atomic workspace state preservation.
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

export const STRATEGY_COMPARISON_VERSION_CONFLICT =
  "STRATEGY_COMPARISON_VERSION_CONFLICT";

export const INVALID_STRATEGY_COMPARISON_STATE =
  "INVALID_STRATEGY_COMPARISON_STATE";

export const STRATEGY_COMPARISON_EXECUTION_FAILED =
  "STRATEGY_COMPARISON_EXECUTION_FAILED";

export type StrategyComparisonDiagnosticStage =
  | "validation"
  | "conflict"
  | "execution";

export interface StrategyComparisonDiagnostic {
  code: string;
  stage: StrategyComparisonDiagnosticStage;
  message: string;
  remediation: string;
  retryable: boolean;
}

export class StrategyComparisonVersionConflictError extends Error {
  readonly code = STRATEGY_COMPARISON_VERSION_CONFLICT;
  readonly stage = "conflict" as const;
  readonly remediation =
    "Reload the latest comparison workspace and retry.";
  readonly retryable = true;

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

  toDiagnostic(): StrategyComparisonDiagnostic {
    return {
      code: this.code,
      stage: this.stage,
      message: "Strategy comparison state changed concurrently.",
      remediation: this.remediation,
      retryable: this.retryable,
    };
  }
}

export class StrategyComparisonValidationError extends Error {
  readonly code = INVALID_STRATEGY_COMPARISON_STATE;
  readonly stage = "validation" as const;
  readonly remediation =
    "Review the comparison inputs and correct invalid values before retrying.";
  readonly retryable = false;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StrategyComparisonValidationError";
  }

  toDiagnostic(): StrategyComparisonDiagnostic {
    return {
      code: this.code,
      stage: this.stage,
      message: "Strategy comparison input is invalid.",
      remediation: this.remediation,
      retryable: this.retryable,
    };
  }
}

export class StrategyComparisonExecutionError extends Error {
  readonly code = STRATEGY_COMPARISON_EXECUTION_FAILED;
  readonly stage = "execution" as const;
  readonly remediation =
    "Refresh the comparison workspace and verify its current state before retrying.";
  readonly retryable = true;

  constructor() {
    super("Strategy comparison execution failed.");
    this.name = "StrategyComparisonExecutionError";
  }

  toDiagnostic(): StrategyComparisonDiagnostic {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
    };
  }
}

/**
 * Convert known and unknown failures into privacy-safe diagnostics.
 *
 * Never expose raw exceptions, wallet addresses, allocation amounts,
 * operation identities, stack traces, or arbitrary request fields.
 */
export function getStrategyComparisonDiagnostic(
  error: unknown,
): StrategyComparisonDiagnostic {
  if (
    error instanceof StrategyComparisonVersionConflictError ||
    error instanceof StrategyComparisonValidationError ||
    error instanceof StrategyComparisonExecutionError
  ) {
    return error.toDiagnostic();
  }

  return {
    code: STRATEGY_COMPARISON_EXECUTION_FAILED,
    stage: "execution",
    message: "Strategy comparison execution failed.",
    remediation:
      "Refresh the workspace and verify its current state before retrying.",
    retryable: true,
  };
}

// Workspace state indexed by normalized wallet address.
const comparisonStateStore =
  new Map<string, StrategyComparisonState>();

// Idempotency records scoped to individual wallets.
const comparisonOperationStore =
  new Map<string, StrategyComparisonOperationRecord>();

// Prevent reentrant writes during synchronous execution.
const activeComparisonUpdates = new Set<string>();

function normalizeWallet(wallet: string): string {
  return wallet.trim().toUpperCase();
}

function cloneState(
  state: StrategyComparisonState,
): StrategyComparisonState {
  return JSON.parse(JSON.stringify(state));
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function validateWalletAddress(walletAddress: string): void {
  if (!isValidIdentifier(walletAddress)) {
    throw new StrategyComparisonValidationError(
      "walletAddress is required.",
      { field: "walletAddress" },
    );
  }
}

function validateOptions(
  options: UpdateComparisonStateOptions,
): void {
  if (
    options.expectedVersion !== undefined &&
    (
      !Number.isSafeInteger(options.expectedVersion) ||
      options.expectedVersion < 0
    )
  ) {
    throw new StrategyComparisonValidationError(
      "expectedVersion must be a non-negative integer.",
      { field: "expectedVersion" },
    );
  }

  if (
    options.operationIdentity !== undefined &&
    !isValidIdentifier(options.operationIdentity)
  ) {
    throw new StrategyComparisonValidationError(
      "operationIdentity must be a non-empty string.",
      { field: "operationIdentity" },
    );
  }
}

function getOperationKey(
  walletAddress: string,
  operationIdentity: string,
): string {
  return JSON.stringify([
    normalizeWallet(walletAddress),
    operationIdentity,
  ]);
}

/** Default initial comparison workspace state. */
export function createDefaultComparisonState(
  walletAddress: string,
): StrategyComparisonState {
  validateWalletAddress(walletAddress);

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

/** Reset workspace state for clean test isolation. */
export function resetComparisonStateStore(): void {
  comparisonStateStore.clear();
  activeComparisonUpdates.clear();
}

export function clearComparisonOperationStore(): void {
  comparisonOperationStore.clear();
}

/** Retrieve current workspace state without exposing mutable references. */
export function getStrategyComparisonState(
  walletAddress: string,
): StrategyComparisonState {
  validateWalletAddress(walletAddress);

  const normalized = normalizeWallet(walletAddress);
  const existing = comparisonStateStore.get(normalized);

  if (existing) {
    return cloneState(existing);
  }

  return createDefaultComparisonState(walletAddress);
}

/** Retrieve the current workspace version. */
export function getStrategyComparisonVersion(
  walletAddress: string,
): number {
  validateWalletAddress(walletAddress);

  const normalized = normalizeWallet(walletAddress);

  return comparisonStateStore.get(normalized)?.version ?? 0;
}

/**
 * Validate comparison inputs before modifying workspace state.
 *
 * Diagnostic messages deliberately exclude submitted values
 * and arbitrary user-controlled identifiers.
 */
export function validateComparisonStateInput(
  input: UpdateComparisonStateInput,
): void {
  if (!isRecord(input)) {
    throw new StrategyComparisonValidationError(
      "Comparison input must be an object.",
      { field: "input" },
    );
  }

  if (
    input.selectedStrategyId !== undefined &&
    input.selectedStrategyId !== null &&
    !isValidIdentifier(input.selectedStrategyId)
  ) {
    throw new StrategyComparisonValidationError(
      "selectedStrategyId must be a non-empty string or null.",
      { field: "selectedStrategyId" },
    );
  }

  if (input.pinnedStrategyIds !== undefined) {
    if (
      !Array.isArray(input.pinnedStrategyIds) ||
      !input.pinnedStrategyIds.every(isValidIdentifier)
    ) {
      throw new StrategyComparisonValidationError(
        "pinnedStrategyIds must contain valid strategy identifiers.",
        { field: "pinnedStrategyIds" },
      );
    }
  }

  if (input.customAssumptions !== undefined) {
    if (!isRecord(input.customAssumptions)) {
      throw new StrategyComparisonValidationError(
        "customAssumptions must be an object.",
        { field: "customAssumptions" },
      );
    }

    const allowedAssumptions = new Set([
      "protocolFeeBps",
      "vaultFeeBps",
      "rebalanceCostBps",
      "slippageBps",
    ]);

    for (const [key, value] of Object.entries(
      input.customAssumptions,
    )) {
      if (!allowedAssumptions.has(key)) {
        throw new StrategyComparisonValidationError(
          "An unsupported comparison assumption was supplied.",
          { field: "customAssumptions" },
        );
      }

      if (
        value !== undefined &&
        (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 10000
        )
      ) {
        throw new StrategyComparisonValidationError(
          `Assumption ${key} must be a finite number between 0 and 10,000 bps.`,
          { field: key },
        );
      }
    }
  }

  if (input.allocatedBalances !== undefined) {
    if (!isRecord(input.allocatedBalances)) {
      throw new StrategyComparisonValidationError(
        "allocatedBalances must be an object.",
        { field: "allocatedBalances" },
      );
    }

    for (const [strategyId, balance] of Object.entries(
      input.allocatedBalances,
    )) {
      if (
        !isValidIdentifier(strategyId) ||
        strategyId === "__proto__" ||
        strategyId === "constructor" ||
        strategyId === "prototype"
      ) {
        throw new StrategyComparisonValidationError(
          "An invalid allocation strategy identifier was supplied.",
          { field: "allocatedBalances" },
        );
      }

      if (
        typeof balance !== "number" ||
        !Number.isFinite(balance) ||
        balance < 0
      ) {
        throw new StrategyComparisonValidationError(
          "Allocated balance must be a non-negative finite number.",
          { field: "allocatedBalances" },
        );
      }
    }
  }
}

export interface UpdateComparisonStateOptions {
  expectedVersion?: number;
  operationIdentity?: string;
  sideEffect?: (
    next: StrategyComparisonState,
    previous: StrategyComparisonState,
  ) => void;
}

/**
 * Updates comparison workspace state using optimistic concurrency.
 *
 * Guarantees:
 * - Invalid inputs cannot modify workspace state.
 * - Stale versions cannot overwrite newer state.
 * - Failed execution restores the previous workspace.
 * - Failed operations are not recorded as successful.
 * - Idempotency records are isolated by wallet.
 *
 * Rollback applies to this in-memory workspace. External side effects
 * must provide their own transactional or compensation guarantees.
 */
export function updateStrategyComparisonState(
  walletAddress: string,
  input: UpdateComparisonStateInput,
  options: UpdateComparisonStateOptions = {},
): {
  state: StrategyComparisonState;
  isReplay: boolean;
} {
  validateWalletAddress(walletAddress);
  validateOptions(options);

  const normalized = normalizeWallet(walletAddress);

  const {
    expectedVersion,
    operationIdentity,
    sideEffect,
  } = options;

  if (activeComparisonUpdates.has(normalized)) {
    throw new StrategyComparisonExecutionError();
  }

  const operationKey = operationIdentity
    ? getOperationKey(normalized, operationIdentity)
    : undefined;

  // 1. Replay previously committed operations.
  if (operationKey) {
    const existingOp =
      comparisonOperationStore.get(operationKey);

    if (existingOp) {
      return {
        state: cloneState(existingOp.result),
        isReplay: true,
      };
    }
  }

  // 2. Retrieve current state.
  const current =
    getStrategyComparisonState(walletAddress);

  const currentVersion = current.version;

  // 3. Reject stale writes.
  if (
    expectedVersion !== undefined &&
    expectedVersion !== currentVersion
  ) {
    throw new StrategyComparisonVersionConflictError(
      expectedVersion,
      currentVersion,
      current,
    );
  }

  // 4. Validate before any mutation.
  validateComparisonStateInput(input);

  if (currentVersion >= Number.MAX_SAFE_INTEGER) {
    throw new StrategyComparisonExecutionError();
  }

  // 5. Prepare the next workspace snapshot.
  const nextState: StrategyComparisonState = {
    walletAddress: normalized,

    selectedStrategyId:
      input.selectedStrategyId !== undefined
        ? input.selectedStrategyId
        : current.selectedStrategyId,

    pinnedStrategyIds:
      input.pinnedStrategyIds !== undefined
        ? [...input.pinnedStrategyIds]
        : [...current.pinnedStrategyIds],

    customAssumptions:
      input.customAssumptions !== undefined
        ? { ...input.customAssumptions }
        : { ...current.customAssumptions },

    allocatedBalances:
      input.allocatedBalances !== undefined
        ? { ...input.allocatedBalances }
        : { ...current.allocatedBalances },

    updatedAt: new Date().toISOString(),

    version: currentVersion + 1,
  };

  // 6. Capture the previous committed state.
  const previousStateSnapshot =
    comparisonStateStore.get(normalized);

  activeComparisonUpdates.add(normalized);

  try {
    comparisonStateStore.set(
      normalized,
      cloneState(nextState),
    );

    // Supply isolated snapshots so callbacks cannot directly
    // mutate committed workspace state.
    if (sideEffect) {
      sideEffect(
        cloneState(nextState),
        cloneState(current),
      );
    }

    // Record idempotency only after successful execution.
    if (operationKey && operationIdentity) {
      comparisonOperationStore.set(operationKey, {
        operationIdentity,
        result: cloneState(nextState),
        createdAt: Date.now(),
      });
    }

    return {
      state: cloneState(nextState),
      isReplay: false,
    };
  } catch {
    // Restore the previous state and allocation balances.
    if (previousStateSnapshot) {
      comparisonStateStore.set(
        normalized,
        previousStateSnapshot,
      );
    } else {
      comparisonStateStore.delete(normalized);
    }

    // Failed operations must remain eligible for safe retry.
    if (operationKey) {
      comparisonOperationStore.delete(operationKey);
    }

    // Never propagate raw execution errors.
    throw new StrategyComparisonExecutionError();
  } finally {
    activeComparisonUpdates.delete(normalized);
  }
}

/**
 * Select a strategy and atomically update its allocation.
 */
export function selectStrategyAndAllocate(
  walletAddress: string,
  strategyId: string,
  allocationUsd: number,
  options: UpdateComparisonStateOptions = {},
): {
  state: StrategyComparisonState;
  isReplay: boolean;
} {
  validateWalletAddress(walletAddress);

  if (
    !isValidIdentifier(strategyId) ||
    strategyId === "__proto__" ||
    strategyId === "constructor" ||
    strategyId === "prototype"
  ) {
    throw new StrategyComparisonValidationError(
      "strategyId must be a valid strategy identifier.",
      { field: "strategyId" },
    );
  }

  if (
    typeof allocationUsd !== "number" ||
    !Number.isFinite(allocationUsd) ||
    allocationUsd < 0
  ) {
    throw new StrategyComparisonValidationError(
      "allocationUsd must be a non-negative finite number.",
      { field: "allocationUsd" },
    );
  }

  const current =
    getStrategyComparisonState(walletAddress);

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