import * as StellarSdk from "@stellar/stellar-sdk";
import NodeCache from "node-cache";
import crypto from "crypto";
import { createHash, randomUUID } from "crypto";
import { slippageRegistry } from "./slippageRegistry";
import { getYieldData } from "./yieldService";
import { freezeService } from "./freezeService";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";

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
  // Safety envelope — extended (merged upstream + branch)
  quoteId: string;
  expiresAt: string;
  ttlMs: number;
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  protocol: string;
  freezeCheckedAt: string;
  quoteSource: "router_simulation" | "fallback_rate";
  quoteSignature?: string;
  // Upstream fields
  issuedAt: string;
  routeHash: string;
  assetConfigVersion: string;
}

export interface VerifyQuoteRequest {
  quoteId: string;
  inputTokenContract?: string;
  vaultTokenContract?: string;
  amountInStroops?: string;
  protocol?: string;
  path?: { contractId: string }[];
  expectedAmountOutStroops?: string;
  minAmountOutStroops?: string;
}

export interface VerifyQuoteResult {
  valid: boolean;
  reason?: string;
  code?: "QUOTE_NOT_FOUND" | "QUOTE_EXPIRED" | "ASSET_MISMATCH" | "ROUTE_MISMATCH" | "FROZEN" | "AMOUNT_MISMATCH" | "SLIPPAGE_INVALID";
  storedQuote?: ZapQuoteResult;
  isFallback?: boolean;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

// In-memory quote store. TTL is managed per entry; keep entries a bit longer than
// quoted TTL so we can return QUOTE_EXPIRED instead of QUOTE_NOT_FOUND for a short window.
const quoteCache = new NodeCache({ stdTTL: 0, checkperiod: 60, useClones: false });

export function getQuoteTtlMs(): number {
  const raw = process.env.ZAP_QUOTE_TTL_MS ?? "60000";
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 60_000;
  // Clamp to 5s – 5min for safety
  return Math.min(Math.max(parsed, 5_000), 300_000);
}

function generateQuoteId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function signQuoteAssumptions(quote: Omit<ZapQuoteResult, "quoteSignature">): string {
  const secret = process.env.ZAP_QUOTE_SIGNING_SECRET ?? "dev-only-signing-secret";
  const payload = JSON.stringify({
    quoteId: quote.quoteId,
    inputTokenContract: quote.inputTokenContract,
    vaultTokenContract: quote.vaultTokenContract,
    amountInStroops: quote.amountInStroops,
    expectedAmountOutStroops: quote.expectedAmountOutStroops,
    minAmountOutStroops: quote.minAmountOutStroops,
    slippageApplied: quote.slippageApplied,
    source: quote.source,
    protocol: quote.protocol,
    path: quote.path,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt,
  });
  return createHash("sha256").update(payload + secret).digest("hex").slice(0, 32);
}

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
): Promise<ZapQuoteResult | null> {
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

    // Interim fields will be overwritten by getZapQuote with envelope values,
    // but return a shape compatible with legacy callers (now includes full envelope with placeholder upstream fields).
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
      quoteId: generateQuoteId(),
      expiresAt: new Date(now + getQuoteTtlMs()).toISOString(),
      ttlMs: getQuoteTtlMs(),
      inputTokenContract: body.inputTokenContract,
      vaultTokenContract: body.vaultTokenContract,
      amountInStroops: body.amountInStroops,
      protocol: body.protocol || "default",
      freezeCheckedAt: new Date(now).toISOString(),
      quoteSource: "router_simulation",
      issuedAt: new Date(now).toISOString(),
      routeHash: computeRouteHash([{ contractId: body.inputTokenContract }, { contractId: body.vaultTokenContract }]),
      assetConfigVersion: getAssetConfigVersion(),
    };
  } catch {
    return null;
  }
}

export function quoteFallback(body: ZapQuoteBody): ZapQuoteResult {
  const amountIn = body.amountInStroops;
  const now = Date.now();
  const ttlMs = getQuoteTtlMs();

  if (body.inputTokenContract === body.vaultTokenContract) {
    const base: Omit<ZapQuoteResult, "quoteSignature"> = {
      path: [{ contractId: body.inputTokenContract }],
      expectedAmountOutStroops: amountIn,
      source: "fallback_rate",
      slippageApplied: 0,
      amountOutAfterSlippage: amountIn,
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: amountIn,
      quoteAgeMs: 0,
      isFallback: true,
      quoteId: generateQuoteId(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      ttlMs,
      inputTokenContract: body.inputTokenContract,
      vaultTokenContract: body.vaultTokenContract,
      amountInStroops: body.amountInStroops,
      protocol: body.protocol || "default",
      freezeCheckedAt: new Date(now).toISOString(),
      quoteSource: "fallback_rate",
      issuedAt: new Date(now).toISOString(),
      routeHash: computeRouteHash([{ contractId: body.inputTokenContract }]),
      assetConfigVersion: getAssetConfigVersion(),
    };
    const sig = signQuoteAssumptions(base);
    return { ...base, quoteSignature: sig };
  }

  const num = process.env.ZAP_FALLBACK_NUMERATOR ?? "1";
  const den = process.env.ZAP_FALLBACK_DENOMINATOR ?? "1";
  const expected = mulDivStroops(amountIn, num, den);

  const base: Omit<ZapQuoteResult, "quoteSignature"> = {
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
    quoteId: generateQuoteId(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs,
    inputTokenContract: body.inputTokenContract,
    vaultTokenContract: body.vaultTokenContract,
    amountInStroops: body.amountInStroops,
    protocol: body.protocol || "default",
    freezeCheckedAt: new Date(now).toISOString(),
    quoteSource: "fallback_rate",
    issuedAt: new Date(now).toISOString(),
    routeHash: computeRouteHash([{ contractId: body.inputTokenContract }, { contractId: body.vaultTokenContract }]),
    assetConfigVersion: getAssetConfigVersion(),
  };
  const sig = signQuoteAssumptions(base);
  return { ...base, quoteSignature: sig };
}

export function isQuoteExpired(quote: Pick<ZapQuoteResult, "expiresAt" | "quotedAt"> & { ttlMs?: number }): boolean {
  const expiresMs = new Date(quote.expiresAt).getTime();
  if (!Number.isNaN(expiresMs)) {
    return Date.now() > expiresMs;
  }
  // Fallback to quotedAt + ttlMs if expiresAt is missing (backward compat)
  const quotedAtMs = new Date(quote.quotedAt).getTime();
  const ttl = quote.ttlMs ?? getQuoteTtlMs();
  if (!Number.isNaN(quotedAtMs)) {
    return Date.now() > quotedAtMs + ttl;
  }
  return true;
}

export function getStoredQuote(quoteId: string): ZapQuoteResult | undefined {
  return quoteCache.get<ZapQuoteResult>(quoteId);
}

export function storeQuote(quote: ZapQuoteResult): void {
  // Keep cache entry longer than quote TTL so callers get QUOTE_EXPIRED instead of QUOTE_NOT_FOUND
  const cacheTtlSec = Math.ceil(quote.ttlMs / 1000) + 60;
  quoteCache.set(quote.quoteId, quote, cacheTtlSec);
}

export function clearQuoteCache(): void {
  quoteCache.flushAll();
}

export function verifyQuoteForExecution(request: VerifyQuoteRequest): VerifyQuoteResult {
  if (!request.quoteId) {
    return { valid: false, reason: "Missing quoteId", code: "QUOTE_NOT_FOUND" };
  }

  const stored = getStoredQuote(request.quoteId);
  if (!stored) {
    return {
      valid: false,
      reason: "Quote not found or expired — please request a fresh quote.",
      code: "QUOTE_NOT_FOUND",
    };
  }

  if (isQuoteExpired(stored)) {
    return {
      valid: false,
      reason: `Quote expired at ${stored.expiresAt}. Please requote.`,
      code: "QUOTE_EXPIRED",
      storedQuote: stored,
      isFallback: stored.isFallback,
    };
  }

  // Freeze invalidation: if a freeze happened after the quote was created, reject.
  if (freezeService.isQuoteInvalidatedByFreeze(stored.quotedAt, stored.protocol) ||
      (request.protocol && freezeService.isQuoteInvalidatedByFreeze(stored.quotedAt, request.protocol))) {
    return {
      valid: false,
      reason: `Quote invalidated by protocol freeze after ${stored.quotedAt}. Please requote.`,
      code: "FROZEN",
      storedQuote: stored,
      isFallback: stored.isFallback,
    };
  }

  // Asset pair binding
  if (request.inputTokenContract && stored.inputTokenContract !== request.inputTokenContract) {
    return {
      valid: false,
      reason: `Quote was for input ${stored.inputTokenContract} but execution requested ${request.inputTokenContract}. Please requote.`,
      code: "ASSET_MISMATCH",
      storedQuote: stored,
      isFallback: stored.isFallback,
    };
  }
  if (request.vaultTokenContract && stored.vaultTokenContract !== request.vaultTokenContract) {
    return {
      valid: false,
      reason: `Quote was for vault asset ${stored.vaultTokenContract} but execution requested ${request.vaultTokenContract}. Please requote.`,
      code: "ASSET_MISMATCH",
      storedQuote: stored,
      isFallback: stored.isFallback,
    };
  }

  // Amount binding (if provided)
  if (request.amountInStroops && stored.amountInStroops !== request.amountInStroops) {
    return {
      valid: false,
      reason: `Quote amount ${stored.amountInStroops} does not match execution amount ${request.amountInStroops}. Please requote.`,
      code: "AMOUNT_MISMATCH",
      storedQuote: stored,
      isFallback: stored.isFallback,
    };
  }

  // Route binding
  if (request.path && Array.isArray(request.path) && request.path.length > 0) {
    const storedRoute = stored.path.map(p => p.contractId);
    const reqRoute = request.path.map((p: any) => p.contractId ?? p);
    if (storedRoute.length !== reqRoute.length || storedRoute.some((c, i) => c !== reqRoute[i])) {
      return {
        valid: false,
        reason: `Quote route ${storedRoute.join("->")} does not match execution route ${reqRoute.join("->")}. Please requote.`,
        code: "ROUTE_MISMATCH",
        storedQuote: stored,
        isFallback: stored.isFallback,
      };
    }
  }

  // Signature verification (if present) — ensures assumptions haven't been tampered with
  if (stored.quoteSignature) {
    const expectedSig = signQuoteAssumptions({ ...stored, quoteSignature: undefined } as any);
    if (stored.quoteSignature !== expectedSig) {
      return {
        valid: false,
        reason: "Quote signature mismatch — assumptions may have been tampered with. Please requote.",
        code: "ROUTE_MISMATCH",
        storedQuote: stored,
        isFallback: stored.isFallback,
      };
    }
  }

  return { valid: true, storedQuote: stored, isFallback: stored.isFallback };
}

export async function getZapQuote(body: ZapQuoteBody): Promise<ZapQuoteResult> {
  if (freezeService.isFrozen(body.protocol)) {
    throw new Error(`Quoting is temporarily disabled for ${body.protocol || "all protocols"} due to safety freeze.`);
  }

  const ttlMs = getQuoteTtlMs();
  const quotedAtMs = Date.now();
  const quotedAt = new Date(quotedAtMs).toISOString();
  const expiresAt = new Date(quotedAtMs + ttlMs).toISOString();

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

  // Guard: if effective slippage is outside bounds, clamp to safe max
  const clampedSlippage = Math.min(Math.max(effectiveSlippage, 0.001), 0.15);

  const expectedOut = BigInt(sim.expectedAmountOutStroops);
  const multiplier = 1 - clampedSlippage;
  const outAfterSlippage = (expectedOut * BigInt(Math.floor(multiplier * 10000))) / BigInt(10000);

  const now = Date.now();

  const quoteId = generateQuoteId();
  const freezeCheckedAt = new Date(now).toISOString();
  const routeHash = computeRouteHash(sim.path);
  const assetConfigVersion = getAssetConfigVersion();
  const issuedAt = quotedAt;

  const enriched: ZapQuoteResult = {
    ...sim,
    slippageApplied: clampedSlippage,
    amountOutAfterSlippage: outAfterSlippage.toString(),
    minAmountOutStroops: outAfterSlippage.toString(),
    quotedAt,
    quoteAgeMs: now - quotedAtMs,
    isFallback: sim.source === "fallback_rate",
    quoteId,
    expiresAt,
    ttlMs,
    inputTokenContract: body.inputTokenContract,
    vaultTokenContract: body.vaultTokenContract,
    amountInStroops: body.amountInStroops,
    protocol,
    freezeCheckedAt,
    quoteSource: sim.source,
    issuedAt,
    routeHash,
    assetConfigVersion,
  };

  // Sign assumptions for tamper detection
  const signature = signQuoteAssumptions(enriched);
  enriched.quoteSignature = signature;

  storeQuote(enriched);

  return enriched;
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
