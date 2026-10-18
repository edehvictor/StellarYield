/**
 * Vault share price reconciliation types (vault share price reconciliation
 * between contract events and the backend cache).
 *
 * The YieldVault contract tracks two instance values that fully determine the
 * share price:
 *
 *   share_price = total_assets * 1_000_000_000_000_000_000 / total_shares
 *
 * (18-decimal fixed point; see `contracts/yield_vault/src/lib.rs::share_price`).
 *
 * Those two totals are mutated only by a small, fixed set of emitted events.
 * This module defines the event vocabulary and the two sides of the
 * comparison — the contract-derived state (reconstructed from events) and the
 * backend cache snapshot — so both the server and the client speak the same
 * shape.
 */

import type {
  ReconcileCauseCategory,
  ReconcileCauseCode,
  ReconcileCauseDescriptor,
  ReconcileCauseSeverity,
} from "./reconcileCause";

/**
 * Contract events emitted by the YieldVault that affect the share-price
 * projection. Each event contributes a deterministic delta to
 * (totalAssets, totalShares).
 *
 * Event signatures (from `contracts/yield_vault/src/`; on-chain topic in brackets):
 *   deposit            [deposit]  (from, amount, shares)                    → assets += amount, shares += shares
 *   withdraw           [withdraw] (to, amount, shares)                      → assets -= amount, shares -= shares
 *   deposit_for        [dep_for]  (payer, beneficiary, amount, shares)      → assets += amount, shares += shares
 *   harvest            [harvest]  (caller, reward, amount_out, keeper_fee)  → assets += (amountOut - keeperFee)
 *   rebalance          [rebal]    (target, amount)                          → assets -= amount
 *   transfer_shares    [tr_sh]    (from, to, shares)                        → no net change (share transfer)
 *   flash_loan         [flash]    (initiator, receiver, amount, fee)        → assets += fee
 *   emergency_withdraw [emg_wd]   (to, net_amount, shares, penalty_bps)     → assets -= netAmount, shares -= shares
 *   rescue             [rescue]   (admin, target, amount)                   → assets -= amount (floored at 0)
 *
 * For `harvest`, `amount` carries `amount_out`; for `flash_loan`, `amount`
 * carries the premium `fee` (the principal is repaid in the same call and does
 * not move the totals).
 *
 * Amounts are carried as integer strings to preserve precision across the
 * JSON boundary (mirroring the existing `VaultActivityEvent.amount` pattern).
 */
export type VaultSharePriceEventType =
  | "deposit"
  | "withdraw"
  | "deposit_for"
  | "harvest"
  | "rebalance"
  | "transfer_shares"
  | "flash_loan"
  | "emergency_withdraw"
  | "rescue";

/** Events that change totalAssets (and possibly shares). */
export const ASSET_MOVING_EVENT_TYPES: readonly VaultSharePriceEventType[] = [
  "deposit",
  "withdraw",
  "deposit_for",
  "harvest",
  "rebalance",
  "flash_loan",
  "emergency_withdraw",
  "rescue",
] as const;

/** Every recognized YieldVault event type, as a runtime array for validation. */
export const VAULT_SHARE_PRICE_EVENT_TYPES: readonly VaultSharePriceEventType[] = [
  "deposit",
  "withdraw",
  "deposit_for",
  "harvest",
  "rebalance",
  "transfer_shares",
  "flash_loan",
  "emergency_withdraw",
  "rescue",
] as const;

/**
 * On-chain event topic (the `symbol_short!` the YieldVault publishes) → event
 * type. Indexers use this to normalize raw contract events; topics not listed
 * here do not move the vault totals and should not be forwarded.
 */
export const CONTRACT_TOPIC_TO_EVENT_TYPE: Readonly<Record<string, VaultSharePriceEventType>> = {
  deposit: "deposit",
  withdraw: "withdraw",
  dep_for: "deposit_for",
  harvest: "harvest",
  rebal: "rebalance",
  tr_sh: "transfer_shares",
  flash: "flash_loan",
  emg_wd: "emergency_withdraw",
  rescue: "rescue",
};

/** True when an event mints or burns shares (and therefore moves totalShares). */
export function isShareMovingEvent(
  eventType: VaultSharePriceEventType,
): boolean {
  return (
    eventType === "deposit" ||
    eventType === "deposit_for" ||
    eventType === "withdraw" ||
    eventType === "emergency_withdraw"
  );
}

export interface VaultSharePriceEvent {
  /** Ledger the event was emitted in. */
  ledger: number;
  /** Transaction hash the event belongs to. */
  txHash: string;
  /** Monotonic index of the event within the transaction. */
  eventIndex: number;
  /** Vault contract identifier. */
  vaultId: string;
  eventType: VaultSharePriceEventType;
  /** Integer-string amount to avoid float loss (USDC micro-units, etc.). */
  amount: string;
  /** Shares for deposit/withdraw/deposit_for/emergency_withdraw; shares moved for transfer_shares. */
  shares?: string;
  /** Keeper fee taken on harvest; the remainder auto-compounds to assets. */
  keeperFee?: string;
}

/**
 * The vault's tracked totals reconstructed solely by replaying contract events.
 * This is the contract-authoritative side of the reconciliation.
 */
export interface VaultProjectedState {
  vaultId: string;
  totalAssets: bigint;
  totalShares: bigint;
  /** How many events were applied to reach this state. */
  eventCount: number;
  /** Ledger of the latest event applied. */
  lastLedger: number;
  /** Transaction hash of the latest applied event. */
  lastTxHash: string;
}

/** The backend cache's view of the vault's share-price snapshot. */
export interface CachedSharePrice {
  vaultId: string;
  /** Share price in base-asset units (1.0 = 1 base asset per share). */
  sharePrice: number;
  totalShares: number;
  totalAssets: number;
  snapshotAt: string;
  projectionVersion?: number;
  lastLedger?: number;
  /** Milliseconds since the cache projection last advanced. */
  projectionAgeMs?: number;
}

export type SharePriceSeverity =
  | "matched"
  | "small"
  | "material"
  | "critical"
  | "unavailable";

export type SharePriceReconStatus = "success" | "partial" | "failed";

/** A single typed discrepancy between the contract-derived and cached state. */
export interface SharePriceMismatch {
  /** Which vault field this row compares. */
  field: "sharePrice" | "totalShares" | "totalAssets";
  /** Value derived from the contract event replay (null when not derivable). */
  contractValue: number | bigint | null;
  /** Value held in the backend cache. */
  cachedValue: number;
  /** contractValue - cachedValue, in the field's native units. */
  delta: number | bigint | null;
  /** Relative drift (contract vs cache), or null when undefined. */
  deltaPct: number | null;
  severity: SharePriceSeverity;
}

/**
 * A named reason a reconciliation did not come out clean. Reuses the shared
 * reconciliation taxonomy so the UI can render one consistent "cause" surface.
 */
export interface SharePriceReconCause
  extends ReconcileCauseDescriptor {
  /** Vault the cause attaches to. */
  vaultId?: string;
  /** This occurrence, with the actual values — the descriptor is generic. */
  detail: string;
  evidence?: {
    contractValue?: number;
    cachedValue?: number;
    deltaPct?: number;
    staleDurationMs?: number;
    projectionVersion?: number;
    lastLedger?: number;
    eventCount?: number;
  };
}

export type {
  ReconcileCauseCategory,
  ReconcileCauseCode,
  ReconcileCauseDescriptor,
  ReconcileCauseSeverity,
};

/** Band thresholds mirrored from the portfolio reconciler (see reconcilePortfolio). */
export const SHARE_PRICE_THRESHOLD = {
  SMALL: 0.01,
  MATERIAL: 0.05,
  CRITICAL: 0.15,
} as const;

/** Milliseconds a cached projection may lag before it is flagged stale. */
export const SHARE_PRICE_STALE_PROJECTION_MS = 5 * 60 * 1000;

/** Error codes returned when an individual input is invalid or unsupported. */
export type VaultSharePriceErrorCode =
  | "INVALID_EVENT"
  | "MALFORMED_INPUT"
  | "NEGATIVE_TOTAL_ASSETS"
  | "NEGATIVE_TOTAL_SHARES"
  | "DIVISION_BY_ZERO"
  | "CACHE_UNAVAILABLE"
  | "UNKNOWN_EVENT_TYPE";

/**
 * Result of reconciling a vault's contract-derived share price against the
 * backend cache.
 */
export interface SharePriceReconciliationResult {
  status: SharePriceReconStatus;
  vaultId: string;
  /** Contract-authoritative totals reconstructed from events (null if unavailable). */
  contractState: VaultProjectedState | null;
  /** Share price derived from the contract state (base units; null if not derivable). */
  contractSharePrice: number | null;
  /** The backend cache snapshot that was compared (null if unavailable). */
  cachedState: CachedSharePrice | null;
  mismatches: SharePriceMismatch[];
  sharesAgree: boolean;
  assetsAgree: boolean;
  /** Max relative drift across all compared fields, or null when nothing comparable. */
  maxDriftPct: number | null;
  isStale: boolean;
  staleDurationMs?: number;
  projectionVersion?: number;
  /** Named, actionable reasons the run was not clean. */
  causes: SharePriceReconCause[];
  /** The cause to act on first, by triage order, or null on a clean run. */
  primaryCause: ReconcileCauseCode | null;
  causeCounts: Partial<Record<ReconcileCauseCode, number>>;
  timestamp: string;
  error?: string;
  errorCode?: VaultSharePriceErrorCode;
}
