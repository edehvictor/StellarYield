/** One hop in a Stellar DEX path (contract-backed asset). */
export interface SwapPathHop {
  contractId: string;
  /** Human-readable hint for UI when known (e.g. "XLM"). */
  label?: string;
}

/** Request body for `POST /api/zap/quote`. */
export interface ZapQuoteRequest {
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  inputDecimals: number;
  vaultDecimals: number;
  slippageTolerance?: number;
}

/** Quote used to show expected vault-token output and to derive `min_amount_out`. */
export interface ZapQuoteResponse {
  path: SwapPathHop[];
  expectedAmountOutStroops: string;
  source: "router_simulation" | "fallback_rate";
  slippageApplied: number;
  amountOutAfterSlippage: string;
  quotedAt: string;
  minAmountOutStroops: string;
  quoteAgeMs: number;
  isFallback: boolean;
  issuedAt: string;
  expiresAt: string;
  routeHash: string;
  assetConfigVersion: number;
}

/** Asset the user can select as zap input (Soroban SAC contract id). */
export interface ZapAssetOption {
  symbol: string;
  name: string;
  contractId: string;
  decimals: number;
  /** Optional URL for UI avatars / icons when provided by the metadata API */
  iconUrl?: string;
}

/** Response from `GET /api/zap/supported-assets` */
export interface ZapSupportedAssetsMetadata {
  assets: ZapAssetOption[];
  vaultToken: ZapAssetOption;
  vaultContractId: string;
}

/**
 * Severity level of a fee drift warning.
 * - "warn":  fee drifted past the minor threshold — user should review.
 * - "error": fee drifted past the hard limit — block signing until re-quoted.
 */
export type FeeDriftSeverity = "warn" | "error";

/**
 * Emitted client-side when the execution fee estimate diverges from the
 * preview fee captured in the quote by more than the configured tolerance.
 *
 * Mirrors the server-side `FeeDriftWarning` shape from `zapQuote.ts` so that
 * a drift object received from the backend can also be rendered without
 * conversion.
 */
export interface FeeDriftWarning {
  /** Discriminant — always "FEE_DRIFT". */
  type: "FEE_DRIFT";
  severity: FeeDriftSeverity;
  /** Fee at quote / preview time (stroops string). */
  previewFee: string;
  /** Fee observed at execution time (stroops string). */
  executionFee: string;
  /** Absolute delta (stroops string). */
  deltaAbs: string;
  /** Relative delta as a fraction between 0 and 1 (e.g. 0.12 = 12%). */
  deltaRelative: number;
  /** Human-readable description for display in the UI. */
  message: string;
}

/** Warn threshold as a fraction (5%). */
export const FEE_DRIFT_WARN_THRESHOLD = 0.05;
/** Error (hard-block) threshold as a fraction (15%). */
export const FEE_DRIFT_ERROR_THRESHOLD = 0.15;

/**
 * Compare a preview fee to an execution fee and return a typed warning when
 * the divergence is material.
 *
 * Returns `null` when the difference is within the warn threshold (rounding
 * noise).
 */
export function detectClientFeeDrift(
  previewFee: string,
  executionFee: string,
): FeeDriftWarning | null {
  const preview = BigInt(previewFee);
  const execution = BigInt(executionFee);

  if (preview === 0n) return null;

  const delta = execution > preview ? execution - preview : preview - execution;
  const deltaRelative = Number(delta) / Number(preview);

  if (deltaRelative < FEE_DRIFT_WARN_THRESHOLD) return null;

  const severity: FeeDriftSeverity = deltaRelative >= FEE_DRIFT_ERROR_THRESHOLD ? "error" : "warn";
  const pct = (deltaRelative * 100).toFixed(2);

  return {
    type: "FEE_DRIFT",
    severity,
    previewFee,
    executionFee,
    deltaAbs: delta.toString(),
    deltaRelative,
    message:
      severity === "error"
        ? `Fee has changed by ${pct}% since the quote was generated. Please re-quote before signing.`
        : `Fee estimate has drifted by ${pct}% from the quoted value. Review before signing.`,
  };
}
