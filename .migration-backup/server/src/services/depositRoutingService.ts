import {
  getZapSupportedAssetsPayload,
  type ZapAssetPublic,
} from "../config/zapAssetsConfig";
import { getZapQuote, type ZapQuoteResult } from "./zapQuote";
import { getFeeOracleEstimate } from "./feeOracleService";

/**
 * Multi-asset deposit routing recommendation (issue #283).
 *
 * Given a basket of assets a user wants to deposit, recommend how each asset is
 * routed into the vault token: assets that already match the vault token are
 * deposited directly, supported non-vault assets are converted via the zap
 * quote service, and unsupported assets are rejected (never silently routed).
 *
 * The result reports, per asset, the route reasoning and expected output, plus
 * aggregate totals, an estimated network fee, and clear unsupported-asset
 * warnings — satisfying the issue's acceptance criteria for route reasoning,
 * expected fees, and unsupported-asset handling.
 *
 * Follow-up to PR #486 (multi-pool path optimisation): when more than one
 * candidate protocol is supplied (or the `DEPOSIT_ROUTING_PROTOCOLS` env var
 * lists multiple), the service quotes every candidate, picks the route whose
 * `amountOutAfterSlippage` is highest, and exposes the alternatives so callers
 * can show the optimisation savings.
 */

export interface DepositAssetInput {
  /** Asset symbol as listed in the supported-assets registry (case-insensitive). */
  symbol: string;
  /** Amount to deposit, expressed in stroops (integer string). */
  amountInStroops: string;
}

export type DepositRouteAction = "direct" | "convert";

export interface DepositRouteAlternative {
  protocol: string;
  expectedVaultAmountStroops: string;
  slippageApplied: number;
  source: ZapQuoteResult["source"];
  isFallback: boolean;
}

export interface DepositRouteRecommendation {
  symbol: string;
  amountInStroops: string;
  action: DepositRouteAction;
  /** Conversion hop path (single hop for a direct deposit). */
  path: { contractId: string; label?: string }[];
  /** Expected vault-token output in stroops, after slippage for conversions. */
  expectedVaultAmountStroops: string;
  slippageApplied: number;
  source: string;
  reasoning: string;
  /** Protocol that produced the chosen quote, if known. */
  protocol?: string;
  /** Quotes that lost to the winner, in descending output order. */
  alternativeQuotes?: DepositRouteAlternative[];
}

export interface UnsupportedAssetWarning {
  symbol: string;
  amountInStroops: string;
  reason: string;
}

export interface DepositRoutingResult {
  vaultToken: { symbol: string; contractId: string; decimals: number };
  routes: DepositRouteRecommendation[];
  unsupportedAssets: UnsupportedAssetWarning[];
  totals: {
    routableAssets: number;
    /** Sum of expected vault-token output across all routable assets, in stroops. */
    expectedVaultAmountStroops: string;
    /** Estimated total network fee (average priority fee × conversion count), in stroops. */
    estimatedNetworkFeeStroops: string;
  };
  warnings: string[];
  generatedAt: string;
}

export interface RecommendDepositRoutingOptions {
  /**
   * Candidate protocols to quote for each non-vault asset. If multiple are
   * supplied, the route with the highest `amountOutAfterSlippage` wins and the
   * losing quotes appear in `alternativeQuotes`. Falls back to
   * `DEPOSIT_ROUTING_PROTOCOLS` (comma-separated) or `["default"]` when unset.
   */
  quoteProtocols?: string[];
}

function sumStroops(values: string[]): string {
  return values
    .reduce((acc, v) => acc + (/^\d+$/.test(v) ? BigInt(v) : BigInt(0)), BigInt(0))
    .toString();
}

function resolveQuoteProtocols(opt?: RecommendDepositRoutingOptions): string[] {
  if (opt?.quoteProtocols && opt.quoteProtocols.length > 0) {
    return opt.quoteProtocols;
  }
  const env = process.env.DEPOSIT_ROUTING_PROTOCOLS?.trim();
  if (env) {
    const protocols = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (protocols.length > 0) return protocols;
  }
  return ["default"];
}

interface CandidateQuote {
  protocol: string;
  quote: ZapQuoteResult;
}

async function quoteAcrossProtocols(
  asset: ZapAssetPublic,
  vaultToken: ZapAssetPublic,
  amountInStroops: string,
  protocols: string[],
): Promise<CandidateQuote[]> {
  const results: CandidateQuote[] = [];
  for (const protocol of protocols) {
    try {
      const quote = await getZapQuote({
        inputTokenContract: asset.contractId,
        vaultTokenContract: vaultToken.contractId,
        amountInStroops,
        inputDecimals: asset.decimals,
        vaultDecimals: vaultToken.decimals,
        protocol: protocol === "default" ? undefined : protocol,
      });
      results.push({ protocol, quote });
    } catch {
      // Skip this protocol on failure; another may still produce a quote.
    }
  }
  return results;
}

function pickBest(candidates: CandidateQuote[]): {
  winner: CandidateQuote;
  losers: CandidateQuote[];
} | null {
  if (candidates.length === 0) return null;
  const sorted = candidates
    .slice()
    .sort((a, b) =>
      BigInt(b.quote.amountOutAfterSlippage) >
      BigInt(a.quote.amountOutAfterSlippage)
        ? 1
        : BigInt(b.quote.amountOutAfterSlippage) <
            BigInt(a.quote.amountOutAfterSlippage)
          ? -1
          : 0,
    );
  return { winner: sorted[0], losers: sorted.slice(1) };
}

/**
 * Compute a deposit routing recommendation for a multi-asset basket.
 *
 * Pure with respect to its inputs aside from the injected registry / quote /
 * fee services, which keeps it straightforward to unit test.
 */
export async function recommendDepositRouting(
  inputs: DepositAssetInput[],
  options?: RecommendDepositRoutingOptions,
): Promise<DepositRoutingResult> {
  const payload = getZapSupportedAssetsPayload();
  const vaultToken = payload.vaultToken;
  const quoteProtocols = resolveQuoteProtocols(options);

  // Case-insensitive symbol lookup over supported assets + the vault token.
  const bySymbol = new Map<string, ZapAssetPublic>();
  for (const asset of [...payload.assets, vaultToken]) {
    bySymbol.set(asset.symbol.trim().toUpperCase(), asset);
  }

  const routes: DepositRouteRecommendation[] = [];
  const unsupportedAssets: UnsupportedAssetWarning[] = [];
  const warnings: string[] = [];
  let conversions = 0;

  for (const input of inputs) {
    const symbol = input.symbol?.trim().toUpperCase();
    const asset = symbol ? bySymbol.get(symbol) : undefined;

    // Security requirement: unsupported assets are rejected clearly, not routed.
    if (!asset) {
      unsupportedAssets.push({
        symbol: input.symbol,
        amountInStroops: input.amountInStroops,
        reason: `Asset "${input.symbol}" is not in the supported-asset registry and was rejected.`,
      });
      continue;
    }

    if (asset.contractId === vaultToken.contractId) {
      routes.push({
        symbol: asset.symbol,
        amountInStroops: input.amountInStroops,
        action: "direct",
        path: [{ contractId: asset.contractId, label: asset.symbol }],
        expectedVaultAmountStroops: input.amountInStroops,
        slippageApplied: 0,
        source: "direct",
        reasoning: `${asset.symbol} is the vault token; deposited directly with no conversion.`,
      });
      continue;
    }

    const candidates = await quoteAcrossProtocols(
      asset,
      vaultToken,
      input.amountInStroops,
      quoteProtocols,
    );
    const picked = pickBest(candidates);
    if (!picked) {
      warnings.push(
        `Could not obtain a conversion quote for ${asset.symbol} across protocols [${quoteProtocols.join(", ")}]; asset skipped.`,
      );
      continue;
    }

    conversions += 1;
    const { winner, losers } = picked;
    const alternatives: DepositRouteAlternative[] = losers.map((l) => ({
      protocol: l.protocol,
      expectedVaultAmountStroops: l.quote.amountOutAfterSlippage,
      slippageApplied: l.quote.slippageApplied,
      source: l.quote.source,
      isFallback: l.quote.isFallback,
    }));

    const protocolLabel =
      winner.protocol === "default" ? winner.quote.source : winner.protocol;
    const reasoningPrefix = `${asset.symbol} converted to ${vaultToken.symbol} via a ${winner.quote.path.length}-hop route (source: ${winner.quote.source}, slippage ${winner.quote.slippageApplied}).`;
    const optimisationNote =
      alternatives.length > 0
        ? ` Selected ${protocolLabel} over ${alternatives.length} alternative quote(s) on output amount.`
        : "";

    routes.push({
      symbol: asset.symbol,
      amountInStroops: input.amountInStroops,
      action: "convert",
      path: winner.quote.path,
      expectedVaultAmountStroops: winner.quote.amountOutAfterSlippage,
      slippageApplied: winner.quote.slippageApplied,
      source: winner.quote.source,
      reasoning: reasoningPrefix + optimisationNote,
      protocol: winner.protocol,
      alternativeQuotes: alternatives.length > 0 ? alternatives : undefined,
    });
  }

  let estimatedNetworkFeeStroops = "0";
  if (conversions > 0) {
    try {
      const fee = await getFeeOracleEstimate();
      estimatedNetworkFeeStroops = (
        BigInt(fee.fees.average) * BigInt(conversions)
      ).toString();
    } catch (error) {
      warnings.push(
        `Network fee estimate unavailable; fee not included (${
          error instanceof Error ? error.message : "unknown error"
        }).`
      );
    }
  }

  if (routes.length === 0) {
    warnings.push("No supported assets in request; nothing to route.");
  }

  return {
    vaultToken: {
      symbol: vaultToken.symbol,
      contractId: vaultToken.contractId,
      decimals: vaultToken.decimals,
    },
    routes,
    unsupportedAssets,
    totals: {
      routableAssets: routes.length,
      expectedVaultAmountStroops: sumStroops(
        routes.map((r) => r.expectedVaultAmountStroops)
      ),
      estimatedNetworkFeeStroops,
    },
    warnings,
    generatedAt: new Date().toISOString(),
  };
}
