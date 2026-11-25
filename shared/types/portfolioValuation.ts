import { sha256Pure, stableStringify } from "./quoteAssumptionFingerprint";

/**
 * Portfolio valuation and completeness model (#1660).
 *
 * In DeFi, oracle latency, missing feeds, or unlisted tokens mean that an asset's
 * current market price may be temporarily or permanently unavailable.
 *
 * This module cleanly separates:
 * 1. Genuine zero balances (deposited: 0, currentValue: 0, or user exited the position)
 * 2. Unpriced / unavailable holdings (user holds funds/shares, but price feed is missing/offline)
 * 3. Priced holdings (known positive or zero market valuation)
 *
 * It provides shared types and pure aggregation helpers so both client (Dashboard,
 * ExposureMap, Position tables) and server (PortfolioService, exports, reports)
 * compute identical completeness states and visibly incomplete totals.
 */

export type ValuationPriceStatus = "priced" | "unpriced" | "zero";

export type PortfolioValuationCompleteness =
  | "complete" // All holdings with active balances have known prices
  | "partial" // Mixed: some holdings are priced, but at least one is unpriced
  | "unavailable" // All non-zero holdings have unavailable prices
  | "empty"; // No active holdings

/** Generic input representing any position or holding. */
export interface PositionValuationInput {
  protocol: string;
  asset: string;
  deposited?: number | null;
  currentValue?: number | null;
  shares?: number | null;
  apy?: number | null;
  fetchedAt?: string | null;
  /** Explicit override or flag when price feed is known to be missing. */
  isPriceUnavailable?: boolean;
  /** Explicit price status from source data. */
  priceStatus?: ValuationPriceStatus;
  /** Optional reason for unavailable valuation (e.g., ORACLE_TIMEOUT). */
  unpricedReason?: string;
}

/** Resolved position with normalized valuation status. */
export interface ResolvedPositionValuation extends PositionValuationInput {
  deposited: number;
  currentValue: number | null;
  priceStatus: ValuationPriceStatus;
  isPriced: boolean;
  isUnpriced: boolean;
  isZeroBalance: boolean;
  /** Calculated P&L; null if valuation is unpriced. */
  pnlUsd: number | null;
}

/** Aggregate valuation summary across a portfolio. */
export interface PortfolioValuationSummary {
  /** Sum of currentValueUsd across all priced holdings. */
  pricedValueUsd: number;
  /**
   * Stated total value. Equals `pricedValueUsd` when complete or partial;
   * `null` when all holdings are unpriced.
   */
  totalValueUsd: number | null;
  /** Total deposited across ALL holdings (including unpriced). */
  totalDepositedUsd: number;
  /** Total deposited across PRICED holdings only (used for accurate P&L calculation). */
  pricedDepositedUsd: number;
  /**
   * Total yield earned on priced holdings (`pricedValueUsd - pricedDepositedUsd`).
   * `null` when no priced holdings exist.
   */
  yieldEarnedUsd: number | null;
  /** Completeness classification. */
  completeness: PortfolioValuationCompleteness;
  /** True strictly when all holdings are fully priced. */
  isComplete: boolean;
  /** Count of unpriced holdings. */
  unpricedCount: number;
  /** Count of priced holdings. */
  pricedCount: number;
  /** Count of genuine zero-balance holdings. */
  zeroCount: number;
  /** Total holdings count. */
  totalCount: number;
  /** Symbols of assets whose price is unavailable. */
  unpricedAssets: string[];
}

/**
 * Resolves the valuation status for an individual position.
 * Distinguishes genuine zero holdings from unpriced holdings.
 */
export function resolveValuationPriceStatus(
  deposited: number | null | undefined,
  currentValue: number | null | undefined,
  options?: {
    isPriceUnavailable?: boolean;
    priceStatus?: ValuationPriceStatus;
  },
): ValuationPriceStatus {
  // Explicit status takes precedence
  if (options?.priceStatus) {
    return options.priceStatus;
  }
  if (options?.isPriceUnavailable === true) {
    return "unpriced";
  }

  // If currentValue is explicitly null, undefined, or NaN, price is unavailable
  if (currentValue === null || currentValue === undefined || Number.isNaN(currentValue)) {
    return "unpriced";
  }

  const dep = typeof deposited === "number" && Number.isFinite(deposited) ? deposited : 0;
  const val = typeof currentValue === "number" && Number.isFinite(currentValue) ? currentValue : 0;

  // Genuine zero balance: deposited is 0 and current value is 0
  if (dep === 0 && val === 0) {
    return "zero";
  }

  return "priced";
}

/**
 * Normalizes an arbitrary position input into a resolved position with strict valuation typing.
 */
export function resolvePositionValuation(
  pos: PositionValuationInput,
): ResolvedPositionValuation {
  const deposited = typeof pos.deposited === "number" && Number.isFinite(pos.deposited)
    ? Math.max(0, pos.deposited)
    : 0;

  const priceStatus = resolveValuationPriceStatus(pos.deposited, pos.currentValue, {
    isPriceUnavailable: pos.isPriceUnavailable,
    priceStatus: pos.priceStatus,
  });

  const currentValue = priceStatus === "unpriced"
    ? null
    : typeof pos.currentValue === "number" && Number.isFinite(pos.currentValue)
      ? Math.max(0, pos.currentValue)
      : 0;

  const pnlUsd = priceStatus === "unpriced"
    ? null
    : (currentValue ?? 0) - deposited;

  return {
    ...pos,
    deposited,
    currentValue,
    priceStatus,
    isPriced: priceStatus === "priced",
    isUnpriced: priceStatus === "unpriced",
    isZeroBalance: priceStatus === "zero",
    pnlUsd,
  };
}

/**
 * Computes portfolio valuation summary, completeness tier, and fair yield breakdown.
 */
export function computePortfolioValuationSummary(
  positions: readonly PositionValuationInput[],
): PortfolioValuationSummary {
  if (!positions || positions.length === 0) {
    return {
      pricedValueUsd: 0,
      totalValueUsd: 0,
      totalDepositedUsd: 0,
      pricedDepositedUsd: 0,
      yieldEarnedUsd: 0,
      completeness: "empty",
      isComplete: true,
      unpricedCount: 0,
      pricedCount: 0,
      zeroCount: 0,
      totalCount: 0,
      unpricedAssets: [],
    };
  }

  const resolved = positions.map(resolvePositionValuation);

  let pricedValueUsd = 0;
  let totalDepositedUsd = 0;
  let pricedDepositedUsd = 0;
  let unpricedCount = 0;
  let pricedCount = 0;
  let zeroCount = 0;
  const unpricedAssetsSet = new Set<string>();

  for (const pos of resolved) {
    totalDepositedUsd += pos.deposited;

    if (pos.priceStatus === "unpriced") {
      unpricedCount++;
      if (pos.asset) {
        unpricedAssetsSet.add(pos.asset);
      }
    } else if (pos.priceStatus === "zero") {
      zeroCount++;
    } else {
      pricedCount++;
      pricedValueUsd += pos.currentValue ?? 0;
      pricedDepositedUsd += pos.deposited;
    }
  }

  const unpricedAssets = Array.from(unpricedAssetsSet);

  let completeness: PortfolioValuationCompleteness;
  let totalValueUsd: number | null;
  let yieldEarnedUsd: number | null;

  if (unpricedCount === 0) {
    completeness = "complete";
    totalValueUsd = pricedValueUsd;
    yieldEarnedUsd = pricedValueUsd - pricedDepositedUsd;
  } else if (pricedCount > 0) {
    // Mixed priced and unpriced holdings
    completeness = "partial";
    totalValueUsd = pricedValueUsd;
    yieldEarnedUsd = pricedValueUsd - pricedDepositedUsd;
  } else {
    // All active holdings are unpriced
    completeness = "unavailable";
    totalValueUsd = null;
    yieldEarnedUsd = null;
  }

  return {
    pricedValueUsd,
    totalValueUsd,
    totalDepositedUsd,
    pricedDepositedUsd,
    yieldEarnedUsd,
    completeness,
    isComplete: completeness === "complete",
    unpricedCount,
    pricedCount,
    zeroCount,
    totalCount: positions.length,
    unpricedAssets,
  };
}

// ── Operation Identity & Duplicate Submission Protection (#1864) ────────────

/**
 * Stellar ledger snapshot that scopes a valuation read and every resulting
 * write. A transition to another network or ledger invalidates the operation.
 */
export interface ValuationContext {
  network: string;
  ledgerSequence: number;
}

/**
 * Payload submitted for portfolio valuation. `context` must identify the
 * network and ledger from which all positions were read.
 */
export interface PortfolioValuationPayload {
  walletAddress: string;
  positions: PositionValuationInput[];
  context: ValuationContext;
  timestamp?: string;
  currency?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Immutable operation identity for valuation operations (#1864).
 */
export interface ValuationOperationIdentity {
  /** Unique operation identifier (UUID, idempotency key, or deterministic hash). */
  operationId: string;
  /** Deterministic SHA-256 fingerprint over canonicalized payload. */
  payloadFingerprint: string;
  /** Human-readable short identifier (e.g. "vop-a1b2c3…d4e5"). */
  shortId: string;
  /** Timestamp when identity was created. */
  createdAt: string;
}

/**
 * Atomic committed valuation effect.
 */
export interface ValuationEffect {
  effectId: string;
  type: "PORTFOLIO_VALUATION_RECORDED" | "BALANCE_SNAPSHOT_STAMPED" | "YIELD_ACCRUAL_EVALUATED";
  walletAddress: string;
  context: ValuationContext;
  totalValueUsd: number | null;
  pricedValueUsd: number;
  yieldEarnedUsd: number | null;
  appliedAt: string;
}

export type ValuationOperationStatus = "in_flight" | "committed" | "failed" | "rejected";

/**
 * Recorded valuation operation for idempotency and duplicate prevention.
 */
export interface ValuationOperationRecord {
  operationId: string;
  payloadFingerprint: string;
  walletAddress: string;
  context: ValuationContext;
  status: ValuationOperationStatus;
  summary?: PortfolioValuationSummary;
  effects?: ValuationEffect[];
  error?: string;
  errorCode?: string;
  createdAt: string;
  committedAt?: string;
  replayedCount: number;
}

/**
 * Canonicalizes a PortfolioValuationPayload into a deterministic object.
 */
export function canonicalizeValuationPayload(
  payload: PortfolioValuationPayload,
): Record<string, unknown> {
  const normalizedPositions = (payload.positions || [])
    .map((p) => ({
      apy: typeof p.apy === "number" && Number.isFinite(p.apy) ? Number(p.apy.toFixed(4)) : null,
      asset: String(p.asset || "").trim().toUpperCase(),
      currentValue:
        typeof p.currentValue === "number" && Number.isFinite(p.currentValue)
          ? Number(p.currentValue.toFixed(4))
          : null,
      deposited:
        typeof p.deposited === "number" && Number.isFinite(p.deposited)
          ? Number(p.deposited.toFixed(4))
          : null,
      isPriceUnavailable: Boolean(p.isPriceUnavailable),
      priceStatus: p.priceStatus || null,
      protocol: String(p.protocol || "").trim(),
      shares:
        typeof p.shares === "number" && Number.isFinite(p.shares)
          ? Number(p.shares.toFixed(4))
          : null,
    }))
    .sort((a, b) => {
      const protoCmp = a.protocol.localeCompare(b.protocol);
      if (protoCmp !== 0) return protoCmp;
      return a.asset.localeCompare(b.asset);
    });

  return {
    currency: String(payload.currency || "USD").toUpperCase(),
    context: {
      network: String(payload.context?.network || "").trim().toLowerCase(),
      ledgerSequence: payload.context?.ledgerSequence ?? null,
    },
    positions: normalizedPositions,
    walletAddress: String(payload.walletAddress || "").trim().toUpperCase(),
  };
}

function normalizeValuationContext(
  context: ValuationContext | null | undefined,
): ValuationContext | null {
  if (
    !context ||
    typeof context.network !== "string" ||
    context.network.trim() === "" ||
    !Number.isSafeInteger(context.ledgerSequence) ||
    context.ledgerSequence <= 0
  ) {
    return null;
  }

  return {
    network: context.network.trim().toLowerCase(),
    ledgerSequence: context.ledgerSequence,
  };
}

function valuationContextsMatch(
  left: ValuationContext | null,
  right: ValuationContext | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.network === right.network &&
    left.ledgerSequence === right.ledgerSequence
  );
}

/**
 * Computes a deterministic SHA-256 fingerprint for a portfolio valuation payload.
 */
export function computeValuationPayloadFingerprint(
  payload: PortfolioValuationPayload,
): { fingerprint: string; shortId: string; canonicalPayload: string } {
  const canonical = canonicalizeValuationPayload(payload);
  const canonicalPayload = stableStringify(canonical);
  const fingerprint = sha256Pure(canonicalPayload);
  const shortId = `vop-${fingerprint.slice(0, 6)}…${fingerprint.slice(-4)}`;

  return { fingerprint, shortId, canonicalPayload };
}

/**
 * Creates an immutable operation identity for a valuation request.
 */
export function createValuationOperationIdentity(
  payload: PortfolioValuationPayload,
  customOperationId?: string,
): ValuationOperationIdentity {
  const { fingerprint, shortId } = computeValuationPayloadFingerprint(payload);
  const operationId =
    customOperationId && customOperationId.trim() !== ""
      ? customOperationId.trim()
      : `val_${fingerprint.slice(0, 16)}_${Date.now()}`;

  return {
    operationId,
    payloadFingerprint: fingerprint,
    shortId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Options for safe valuation execution with state preservation.
 */
export interface SafeValuationOptions<TState, TResult> {
  payload: PortfolioValuationPayload;
  operationIdentity: ValuationOperationIdentity;
  currentState: TState;
  /** Re-reads the active network/ledger before and after the write callback. */
  getCurrentContext: () => ValuationContext;
  validate?: (payload: PortfolioValuationPayload) => boolean | string;
  /**
   * Bind side effects to the supplied context; never infer the active network
   * or ledger again while writing.
   */
  execute?: (
    summary: PortfolioValuationSummary,
    context: ValuationContext,
  ) => Promise<TResult> | TResult;
  onSuccessStateUpdate?: (currentState: TState, summary: PortfolioValuationSummary) => TState;
}

export interface SafeValuationResult<TState, TResult> {
  success: boolean;
  state: TState;
  summary?: PortfolioValuationSummary;
  result?: TResult;
  effects?: ValuationEffect[];
  replayed?: boolean;
  duplicate?: boolean;
  error?: string;
  errorCode?:
    | "VALIDATION_FAILED"
    | "EXECUTION_FAILED"
    | "OPERATION_IDENTITY_CONFLICT"
    | "DUPLICATE_VALUATION_IN_PROGRESS"
    | "VALUATION_CONTEXT_MISMATCH";
  isRecoverable: boolean;
}

/**
 * In-memory manager for portfolio valuation operation identity and duplicate protection.
 */
export class ValuationOperationManager {
  private readonly operations = new Map<string, ValuationOperationRecord>();

  constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) {}

  public getOperation(operationId: string): ValuationOperationRecord | undefined {
    return this.operations.get(operationId);
  }

  public clear(): void {
    this.operations.clear();
  }

  /**
   * Safely executes or replays a valuation operation.
   *
   * ACCEPTANCE CRITERIA GUARANTEES:
   * 1. Add an operation identity so safe retries cannot apply the same effect twice.
   * 2. Preserve existing state and balances when validation or execution fails.
   * 3. Conflicting reuse with different payload returns OPERATION_IDENTITY_CONFLICT.
   * 4. Idempotent retry returns committed summary with duplicate: true and effects unchanged.
   */
  public async executeValuation<TState, TResult>(
    options: SafeValuationOptions<TState, TResult>,
  ): Promise<SafeValuationResult<TState, TResult>> {
    const {
      payload,
      operationIdentity,
      currentState,
      getCurrentContext,
      validate,
      execute,
      onSuccessStateUpdate,
    } = options;

    const { operationId, payloadFingerprint } = operationIdentity;
    const context = normalizeValuationContext(payload.context);
    const actualPayloadFingerprint = computeValuationPayloadFingerprint(payload).fingerprint;

    if (payloadFingerprint !== actualPayloadFingerprint) {
      return {
        success: false,
        state: currentState,
        error: "Operation identity conflict: parameters do not match the submitted payload.",
        errorCode: "OPERATION_IDENTITY_CONFLICT",
        isRecoverable: false,
      };
    }

    const hasCurrentContext = (): boolean =>
      valuationContextsMatch(context, normalizeValuationContext(getCurrentContext()));

    if (!context || !hasCurrentContext()) {
      return {
        success: false,
        state: currentState,
        error: "Valuation context does not match the active network and ledger.",
        errorCode: "VALUATION_CONTEXT_MISMATCH",
        isRecoverable: true,
      };
    }

    // 1. Check for existing operation identity
    const existing = this.operations.get(operationId);
    if (existing) {
      // Conflict check: Same operation ID used with different payload
      if (
        existing.payloadFingerprint !== actualPayloadFingerprint ||
        !valuationContextsMatch(existing.context, context)
      ) {
        return {
          success: false,
          state: currentState, // Preserved untouched
          error: "Operation identity conflict: parameters do not match initial submission.",
          errorCode: "OPERATION_IDENTITY_CONFLICT",
          isRecoverable: false,
        };
      }

      // In-flight check: Concurrent duplicate submission
      if (existing.status === "in_flight") {
        return {
          success: false,
          state: currentState, // Preserved untouched
          error: "Valuation operation is already in progress.",
          errorCode: "DUPLICATE_VALUATION_IN_PROGRESS",
          isRecoverable: true,
        };
      }

      // Committed replay: Idempotent return without applying effects a second time
      if (existing.status === "committed") {
        existing.replayedCount += 1;
        return {
          success: true,
          state: currentState, // No duplicate state mutation
          summary: existing.summary,
          effects: existing.effects,
          replayed: true,
          duplicate: true,
          isRecoverable: false,
        };
      }
    }

    // 2. Validate payload at the boundary - preserve state on failure
    if (validate) {
      const val = validate(payload);
      if (val !== true) {
        const errorMsg = typeof val === "string" ? val : "Valuation validation failed.";
        this.operations.set(operationId, {
          operationId,
          payloadFingerprint: actualPayloadFingerprint,
          walletAddress: payload.walletAddress,
          context,
          status: "rejected",
          error: errorMsg,
          errorCode: "VALIDATION_FAILED",
          createdAt: new Date().toISOString(),
          replayedCount: 0,
        });

        return {
          success: false,
          state: currentState, // Preserved untouched
          error: errorMsg,
          errorCode: "VALIDATION_FAILED",
          isRecoverable: true,
        };
      }
    }

    // Mark as in-flight
    this.operations.set(operationId, {
      operationId,
      payloadFingerprint: actualPayloadFingerprint,
      walletAddress: payload.walletAddress,
      context,
      status: "in_flight",
      createdAt: new Date().toISOString(),
      replayedCount: 0,
    });

    try {
      // 3. Compute pure valuation summary
      const summary = computePortfolioValuationSummary(payload.positions);

      if (!hasCurrentContext()) {
        const error = "Valuation context changed before execution.";
        this.operations.set(operationId, {
          operationId,
          payloadFingerprint: actualPayloadFingerprint,
          walletAddress: payload.walletAddress,
          context,
          status: "rejected",
          error,
          errorCode: "VALUATION_CONTEXT_MISMATCH",
          createdAt: this.operations.get(operationId)?.createdAt || new Date().toISOString(),
          replayedCount: 0,
        });
        return {
          success: false,
          state: currentState,
          error,
          errorCode: "VALUATION_CONTEXT_MISMATCH",
          isRecoverable: true,
        };
      }

      // The callback receives the read context and must bind writes to it.
      let execResult: TResult | undefined;
      if (execute) {
        execResult = await execute(summary, context);
      }

      if (!hasCurrentContext()) {
        const error = "Valuation context changed during execution.";
        this.operations.set(operationId, {
          operationId,
          payloadFingerprint: actualPayloadFingerprint,
          walletAddress: payload.walletAddress,
          context,
          status: "rejected",
          error,
          errorCode: "VALUATION_CONTEXT_MISMATCH",
          createdAt: this.operations.get(operationId)?.createdAt || new Date().toISOString(),
          replayedCount: 0,
        });
        return {
          success: false,
          state: currentState,
          error,
          errorCode: "VALUATION_CONTEXT_MISMATCH",
          isRecoverable: true,
        };
      }

      // 4. Generate committed atomic effects
      const effect: ValuationEffect = {
        effectId: `eff_${operationId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`,
        type: "PORTFOLIO_VALUATION_RECORDED",
        walletAddress: payload.walletAddress,
        context,
        totalValueUsd: summary.totalValueUsd,
        pricedValueUsd: summary.pricedValueUsd,
        yieldEarnedUsd: summary.yieldEarnedUsd,
        appliedAt: new Date().toISOString(),
      };

      // Commit record in registry
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint: actualPayloadFingerprint,
        walletAddress: payload.walletAddress,
        context,
        status: "committed",
        summary,
        effects: [effect],
        createdAt: this.operations.get(operationId)?.createdAt || new Date().toISOString(),
        committedAt: new Date().toISOString(),
        replayedCount: 0,
      });

      // Update state safely
      const updatedState = onSuccessStateUpdate
        ? onSuccessStateUpdate(currentState, summary)
        : currentState;

      return {
        success: true,
        state: updatedState,
        summary,
        result: execResult,
        effects: [effect],
        replayed: false,
        duplicate: false,
        isRecoverable: false,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Valuation execution failed.";

      // Mark operation as failed, allow safe retry
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint: actualPayloadFingerprint,
        walletAddress: payload.walletAddress,
        context,
        status: "failed",
        error: errorMsg,
        errorCode: "EXECUTION_FAILED",
        createdAt: this.operations.get(operationId)?.createdAt || new Date().toISOString(),
        replayedCount: 0,
      });

      // Crucial: Original state and balances preserved untouched
      return {
        success: false,
        state: currentState, // Preserved untouched
        error: errorMsg,
        errorCode: "EXECUTION_FAILED",
        isRecoverable: true,
      };
    }
  }
}

/** Global shared instance of ValuationOperationManager. */
export const defaultValuationOperationManager = new ValuationOperationManager();
