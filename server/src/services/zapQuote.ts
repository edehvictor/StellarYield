import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";
import { slippageRegistry } from "./slippageRegistry";
import { getYieldData } from "./yieldService";
import { freezeService } from "./freezeService";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { recordFailure, resolveNetworkLabel } from "../monitoring/prometheus";

export interface ZapQuoteBody {
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  inputDecimals: number;
  vaultDecimals: number;
  slippageTolerance?: number;
  protocol?: string;
}

export interface ZapQuoteResult {
  path: { contractId: string; label?: string }[];
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
  assetConfigVersion: string;
}

/**
 * Severity of a fee drift warning.
 * - "warn":  delta is material (≥ FEE_DRIFT_WARN_THRESHOLD) — user should be
 *            informed but the transaction is not automatically blocked.
 * - "error": delta exceeds the hard limit (≥ FEE_DRIFT_ERROR_THRESHOLD) —
 *            the UI should block signing until the user re-quotes.
 */
export type FeeDriftSeverity = "warn" | "error";

/**
 * Emitted when the fee baked into an execution estimate diverges from the
 * preview fee by more than the configured tolerance.
 */
export interface FeeDriftWarning {
  /** Discriminant so callers can narrow on type. */
  type: "FEE_DRIFT";
  severity: FeeDriftSeverity;
  /** Fee amount captured at quote time (in the quote's native unit). */
  previewFee: string;
  /** Fee amount observed at execution time. */
  executionFee: string;
  /** Absolute delta between preview and execution fee. */
  deltaAbs: string;
  /** Relative delta as a fraction between 0 and 1 (e.g. 0.12 = 12%). */
  deltaRelative: number;
  /** Human-readable description for UI display. */
  message: string;
}

/**
 * Fractional delta at which a fee discrepancy becomes a *warn*-level drift.
 * Default: 5% (0.05). Override via FEE_DRIFT_WARN_THRESHOLD env var.
 */
export function getFeeDriftWarnThreshold(): number {
  const raw = process.env.FEE_DRIFT_WARN_THRESHOLD;
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.05;
}

/**
 * Fractional delta at which a fee discrepancy becomes an *error*-level drift.
 * Default: 15% (0.15). Override via FEE_DRIFT_ERROR_THRESHOLD env var.
 */
export function getFeeDriftErrorThreshold(): number {
  const raw = process.env.FEE_DRIFT_ERROR_THRESHOLD;
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.15;
}

/**
 * Compare a fee captured at quote preview time against the fee observed at
 * execution time and emit a typed `FeeDriftWarning` when the divergence
 * exceeds the configured tolerance.
 *
 * Both fees are expressed as string-encoded integer stroops (or any consistent
 * unit — the function only cares about the ratio, not the unit).
 *
 * Returns `null` when the divergence is below the warn threshold (i.e. the
 * difference is just normal rounding noise).
 */
export function detectFeeDrift(
  previewFee: string,
  executionFee: string,
): FeeDriftWarning | null {
  const preview = BigInt(previewFee);
  const execution = BigInt(executionFee);

  if (preview === 0n) {
    // Cannot compute a meaningful relative delta when the preview fee is zero.
    return null;
  }

  const delta = execution > preview ? execution - preview : preview - execution;
  // Use number arithmetic for the ratio — stroops fit safely in a float64.
  const deltaRelative = Number(delta) / Number(preview);

  const warnThreshold = getFeeDriftWarnThreshold();
  const errorThreshold = getFeeDriftErrorThreshold();

  if (deltaRelative < warnThreshold) {
    return null;
  }

  const severity: FeeDriftSeverity = deltaRelative >= errorThreshold ? "error" : "warn";
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

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

function mulDivStroops(amountIn: string, numerator: string, denominator: string): string {
  const a = BigInt(amountIn);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === BigInt(0)) {
    return "0";
  }
  return ((a * n) / d).toString();
}

export function getAssetConfigVersion(): string {
  const payload = getZapSupportedAssetsPayload();
  const data = JSON.stringify(payload);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function computeRouteHash(path: { contractId: string }[]): string {
  const ids = path.map(p => p.contractId).join("->");
  return crypto.createHash("sha256").update(ids).digest("hex");
}

export async function quoteViaRouterSimulation(
  body: ZapQuoteBody,
): Promise<Omit<ZapQuoteResult, "issuedAt" | "expiresAt" | "routeHash" | "assetConfigVersion"> | null> {
  const routerId = process.env.DEX_ROUTER_CONTRACT_ID;
  const simSource = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  if (!routerId || !simSource) {
    return null;
  }

  try {
    const server = new StellarSdk.rpc.Server(rpcUrl);
    const router = new StellarSdk.Contract(routerId);
    const amountIn = BigInt(body.amountInStroops);
    const minOut = BigInt(0);

    const op = router.call(
      "swap",
      new StellarSdk.Address(body.inputTokenContract).toScVal(),
      new StellarSdk.Address(body.vaultTokenContract).toScVal(),
      StellarSdk.nativeToScVal(amountIn, { type: "i128" }),
      StellarSdk.nativeToScVal(minOut, { type: "i128" }),
    );

    const source = await server.getAccount(simSource);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase:
        process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const timeoutMs = parseInt(process.env.SOROBAN_RPC_TIMEOUT_MS ?? "10000", 10);
    const simulated = await Promise.race([
      server.simulateTransaction(tx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs)
      ),
    ]);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      return null;
    }

    const success = simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    const retval = success.result?.retval;
    if (!retval) {
      return null;
    }

    const out = StellarSdk.scValToNative(retval) as bigint | number | string;
    const expected =
      typeof out === "bigint" ? out : BigInt(String(out));

    const now = Date.now();

    return {
      path: [
        { contractId: body.inputTokenContract, label: "in" },
        { contractId: body.vaultTokenContract, label: "out" },
      ],
      expectedAmountOutStroops: expected.toString(),
      source: "router_simulation",
      slippageApplied: 0,
      amountOutAfterSlippage: expected.toString(),
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: expected.toString(),
      quoteAgeMs: 0,
      isFallback: false,
    };
  } catch {
    recordFailure({
      provider: body.protocol || "default",
      network: resolveNetworkLabel(),
      route: "zap/quote",
      failure_category: "router_simulation_failed",
    });
    return null;
  }
}

export function quoteFallback(body: ZapQuoteBody): Omit<ZapQuoteResult, "issuedAt" | "expiresAt" | "routeHash" | "assetConfigVersion"> {
  const amountIn = body.amountInStroops;
  const now = Date.now();

  if (body.inputTokenContract === body.vaultTokenContract) {
    return {
      path: [{ contractId: body.inputTokenContract }],
      expectedAmountOutStroops: amountIn,
      source: "fallback_rate",
      slippageApplied: 0,
      amountOutAfterSlippage: amountIn,
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: amountIn,
      quoteAgeMs: 0,
      isFallback: true,
    };
  }

  const num = process.env.ZAP_FALLBACK_NUMERATOR ?? "1";
  const den = process.env.ZAP_FALLBACK_DENOMINATOR ?? "1";
  const expected = mulDivStroops(amountIn, num, den);

  return {
    path: [
      { contractId: body.inputTokenContract, label: "in" },
      { contractId: body.vaultTokenContract, label: "out" },
    ],
    expectedAmountOutStroops: expected,
    source: "fallback_rate",
    slippageApplied: 0,
    amountOutAfterSlippage: expected,
    quotedAt: new Date(now).toISOString(),
    minAmountOutStroops: expected,
    quoteAgeMs: 0,
    isFallback: true,
  };
}

export async function getZapQuote(body: ZapQuoteBody): Promise<ZapQuoteResult> {
  if (freezeService.isFrozen(body.protocol)) {
    recordFailure({
      provider: body.protocol || "default",
      network: resolveNetworkLabel(),
      route: "zap/quote",
      failure_category: "frozen",
    });
    throw new Error(`Quoting is temporarily disabled for ${body.protocol || "all protocols"} due to safety freeze.`);
  }

  const quotedAt = new Date().toISOString();

  const sim = (await quoteViaRouterSimulation(body)) || quoteFallback(body);

  const protocol = body.protocol || "default";
  const model = slippageRegistry.getModel(protocol);

  const yieldData = await getYieldData();
  const protocolData = yieldData.find(y => y.protocolName.toLowerCase() === protocol.toLowerCase());
  const tvl = BigInt(Math.floor(protocolData?.tvl || 10_000_000));

  const amountIn = BigInt(body.amountInStroops);
  const slippage = model.calculateSlippage(amountIn, tvl);

  const userSlippage = body.slippageTolerance !== undefined
    ? Math.min(Math.max(body.slippageTolerance, 0.001), 0.15)
    : slippage;

  const effectiveSlippage = Math.max(slippage, userSlippage);

  const expectedOut = BigInt(sim.expectedAmountOutStroops);
  const multiplier = 1 - effectiveSlippage;
  const outAfterSlippage = (expectedOut * BigInt(Math.floor(multiplier * 10000))) / BigInt(10000);

  const now = Date.now();
  const quotedAtMs = new Date(quotedAt).getTime();

  const routeHash = computeRouteHash(sim.path);
  const assetConfigVersion = getAssetConfigVersion();
  const issuedAt = quotedAt;
  const expiresAt = new Date(quotedAtMs + 60 * 1000).toISOString();

  return {
    ...sim,
    slippageApplied: effectiveSlippage,
    amountOutAfterSlippage: outAfterSlippage.toString(),
    minAmountOutStroops: outAfterSlippage.toString(),
    quotedAt,
    quoteAgeMs: now - quotedAtMs,
    isFallback: sim.source === "fallback_rate",
    issuedAt,
    expiresAt,
    routeHash,
    assetConfigVersion,
  };
}

export function verifyZapQuote(quote: any): { valid: boolean; reason?: string; errorCode?: string } {
  const now = Date.now();
  if (!quote || typeof quote !== "object") {
    return { valid: false, reason: "Invalid quote format", errorCode: "INVALID_QUOTE" };
  }
  if (!quote.expiresAt || new Date(quote.expiresAt).getTime() < now) {
    return { valid: false, reason: "Quote has expired", errorCode: "STALE_QUOTE" };
  }
  const currentVersion = getAssetConfigVersion();
  if (quote.assetConfigVersion !== currentVersion) {
    return { valid: false, reason: "Asset configuration has drifted", errorCode: "CONFIG_DRIFT" };
  }
  if (!quote.path || !Array.isArray(quote.path)) {
    return { valid: false, reason: "Invalid path in quote", errorCode: "ROUTE_MISMATCH" };
  }
  const currentRouteHash = computeRouteHash(quote.path);
  if (quote.routeHash !== currentRouteHash) {
    return { valid: false, reason: "Route path mismatch", errorCode: "ROUTE_MISMATCH" };
  }
  // Check unsupported asset transitions
  const payload = getZapSupportedAssetsPayload();
  const supportedIds = new Set([
    ...payload.assets.map(a => a.contractId),
    payload.vaultToken.contractId
  ]);
  for (const hop of quote.path) {
    if (!supportedIds.has(hop.contractId)) {
      return { valid: false, reason: `Asset ${hop.contractId} is no longer supported`, errorCode: "UNSUPPORTED_ASSET" };
    }
  }
  // Check slippage exceeded — reject quotes where applied slippage exceeds maximum threshold
  if (typeof quote.slippageApplied === "number" && quote.slippageApplied > 0.15) {
    return { valid: false, reason: `Slippage ${(quote.slippageApplied * 100).toFixed(2)}% exceeds maximum allowed threshold of 15%`, errorCode: "SLIPPAGE_EXCEEDED" };
  }
  return { valid: true };
}
