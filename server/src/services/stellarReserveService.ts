/**
 * Stellar minimum-balance reserve calculation (#1148).
 *
 * A Stellar account must always hold at least its "minimum balance" in XLM,
 * or the network rejects any operation that would take it below that floor.
 * The minimum balance is:
 *
 *   minBalance = (2 + numSubentries) * baseReserve
 *
 * where `baseReserve` is currently 0.5 XLM (network-wide protocol constant)
 * and `numSubentries` counts trustlines, offers, signers, and data entries
 * on the account. The fixed "2" accounts for the account entry itself.
 * Source: https://developers.stellar.org/docs/learn/fundamentals/lumens#minimum-balance
 *
 * A zap deposit can push a wallet below this floor in three ways:
 *   1. The network fee for the zap transaction is paid in XLM.
 *   2. A new trustline may be created for an asset the wallet doesn't
 *      already hold (e.g. the vault token), which raises numSubentries
 *      and therefore the minimum balance itself.
 *   3. If the deposited asset *is* XLM, the deposited amount leaves the
 *      account's spendable balance too.
 *
 * This module calculates the wallet's balance after all three effects and
 * blocks the zap with a typed reason before a transaction is ever built if
 * that would leave the wallet below its (possibly now-higher) minimum
 * balance — mirroring how `checkRouteLiquidityDepth` in `deposits.ts`
 * blocks with a typed reason before routing.
 */

/** Stellar's current base reserve, in XLM. Network-wide protocol constant. */
export const STELLAR_BASE_RESERVE_XLM = 0.5;

/** Fixed subentry-equivalent charged for the account entry itself. */
export const STELLAR_ACCOUNT_BASE_SUBENTRIES = 2;

/**
 * A small safety cushion (in XLM) added on top of the calculated minimum
 * balance so the wallet doesn't land exactly on the reserve floor — the
 * account should remain usable for at least one more small operation
 * afterward, not be left razor-thin. Configurable via
 * ZAP_RESERVE_SAFETY_BUFFER_XLM; defaults to one additional base reserve.
 */
export function getReserveSafetyBufferXlm(): number {
  const raw = process.env.ZAP_RESERVE_SAFETY_BUFFER_XLM;
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : STELLAR_BASE_RESERVE_XLM;
}

/**
 * Calculates a Stellar account's minimum required balance in XLM given its
 * current subentry count and any additional subentries (e.g. a new
 * trustline) the pending operation would add.
 */
export function calculateMinimumReserveXlm(
  currentSubentryCount: number,
  additionalSubentries: number = 0,
): number {
  const subentries = Math.max(0, currentSubentryCount) + Math.max(0, additionalSubentries);
  return (STELLAR_ACCOUNT_BASE_SUBENTRIES + subentries) * STELLAR_BASE_RESERVE_XLM;
}

export interface WalletReserveSnapshot {
  /** The wallet's current spendable XLM balance (native asset). */
  xlmBalance: number;
  /** Current number of subentries (trustlines, offers, signers, data entries). */
  subentryCount: number;
  /** True when the wallet does not yet hold a trustline for the vault token. */
  needsNewVaultTrustline: boolean;
}

export interface ZapReserveCheckInput extends WalletReserveSnapshot {
  /** Estimated network fee for the zap transaction, in XLM. */
  estimatedNetworkFeeXlm: number;
  /** Amount of XLM leaving the account as part of the deposit (0 when the
   *  input asset is not XLM — depositing a non-native asset doesn't reduce
   *  the account's native balance beyond the network fee). */
  xlmLeavingAccount: number;
}

export type ZapReserveBlockReason =
  | "INSUFFICIENT_RESERVE_AFTER_FEES"
  | "INSUFFICIENT_RESERVE_AFTER_TRUSTLINE"
  | "INSUFFICIENT_RESERVE_AFTER_DEPOSIT";

export interface ZapReserveCheckResult {
  safe: boolean;
  /** Minimum balance (XLM) the wallet must maintain, including the safety buffer. */
  requiredReserveXlm: number;
  /** Wallet's XLM balance projected after fees, any new trustline, and the deposit. */
  projectedBalanceXlm: number;
  blockReason?: ZapReserveBlockReason;
  message?: string;
}

/**
 * Evaluates whether a zap deposit would leave a wallet below its required
 * minimum balance, accounting for the transaction fee, a possible new
 * trustline, and XLM leaving the account as part of the deposit.
 *
 * Pure function — takes an already-fetched account snapshot plus the
 * transaction's projected costs, so it's trivial to unit test without a
 * network dependency. Never throws; returns a typed result the caller can
 * turn directly into a blocking API response.
 */
export function evaluateZapReserveSafety(
  input: ZapReserveCheckInput,
): ZapReserveCheckResult {
  const additionalSubentries = input.needsNewVaultTrustline ? 1 : 0;
  const baseRequiredReserveXlm = calculateMinimumReserveXlm(
    input.subentryCount,
    additionalSubentries,
  );
  const requiredReserveXlm = baseRequiredReserveXlm + getReserveSafetyBufferXlm();

  const projectedBalanceXlm =
    input.xlmBalance - input.estimatedNetworkFeeXlm - input.xlmLeavingAccount;

  if (projectedBalanceXlm >= requiredReserveXlm) {
    return { safe: true, requiredReserveXlm, projectedBalanceXlm };
  }

  // Attribute the shortfall to the most specific cause so the UI can explain
  // *why*, not just that it's blocked.
  const balanceAfterFeeOnly = input.xlmBalance - input.estimatedNetworkFeeXlm;
  const requiredWithoutNewTrustline = calculateMinimumReserveXlm(input.subentryCount) +
    getReserveSafetyBufferXlm();

  let blockReason: ZapReserveBlockReason;
  let message: string;

  if (balanceAfterFeeOnly < requiredWithoutNewTrustline) {
    blockReason = "INSUFFICIENT_RESERVE_AFTER_FEES";
    message = `This zap would leave your wallet with ${projectedBalanceXlm.toFixed(7)} XLM, below the ${requiredReserveXlm.toFixed(7)} XLM minimum balance required after network fees. Reduce the deposit amount or add XLM to your wallet.`;
  } else if (additionalSubentries > 0 && projectedBalanceXlm < requiredReserveXlm) {
    blockReason = "INSUFFICIENT_RESERVE_AFTER_TRUSTLINE";
    message = `This zap requires creating a new trustline, which raises your wallet's minimum balance to ${requiredReserveXlm.toFixed(7)} XLM. Your projected balance of ${projectedBalanceXlm.toFixed(7)} XLM would fall below that. Reduce the deposit amount or add XLM to your wallet.`;
  } else {
    blockReason = "INSUFFICIENT_RESERVE_AFTER_DEPOSIT";
    message = `This zap would leave your wallet with ${projectedBalanceXlm.toFixed(7)} XLM, below the ${requiredReserveXlm.toFixed(7)} XLM minimum balance required. Reduce the deposit amount or add XLM to your wallet.`;
  }

  return { safe: false, requiredReserveXlm, projectedBalanceXlm, blockReason, message };
}

// ── Horizon-backed wallet snapshot lookup ──────────────────────────────────

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

interface HorizonAccountResponse {
  subentry_count: number;
  balances: HorizonBalanceLine[];
}

/**
 * Fetches a wallet's current XLM balance and subentry count from Horizon,
 * and whether it already holds a trustline for the given vault token asset.
 *
 * Returns `null` when the account can't be loaded (not yet funded, Horizon
 * unreachable, etc.) so callers can degrade gracefully rather than blocking
 * a zap on infrastructure trouble.
 */
export async function fetchWalletReserveSnapshot(
  walletAddress: string,
  vaultTokenContractId: string,
): Promise<WalletReserveSnapshot | null> {
  try {
    const timeoutMs = parseInt(process.env.STELLAR_HORIZON_TIMEOUT_MS ?? "10000", 10);
    const res = await Promise.race([
      fetch(`${HORIZON_URL}/accounts/${walletAddress}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs),
      ),
    ]);
    if (!res.ok) return null;

    const account = (await res.json()) as HorizonAccountResponse;
    const nativeLine = account.balances.find((b) => b.asset_type === "native");
    const xlmBalance = nativeLine ? parseFloat(nativeLine.balance) : 0;

    // A Soroban SAC trustline for a contract-backed asset shows up in
    // Horizon balances as a "liquidity_pool_shares"-style entry keyed by
    // asset issuer/contract; SAC wrapper trustlines aren't reliably
    // distinguishable from classic trustlines via this endpoint alone, so
    // the caller is expected to also account for contract-level trustline
    // existence when known. Here we conservatively check whether any
    // existing balance line's issuer matches the vault token contract id.
    const hasVaultTrustline = account.balances.some(
      (b) => b.asset_issuer === vaultTokenContractId,
    );

    return {
      xlmBalance,
      subentryCount: account.subentry_count ?? 0,
      needsNewVaultTrustline: !hasVaultTrustline,
    };
  } catch {
    return null;
  }
}
