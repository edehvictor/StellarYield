import {
  getZapSupportedAssetsPayload,
  type ZapAssetPublic,
} from "../config/zapAssetsConfig";
import { getZapQuote } from "./zapQuote";
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
 */

export interface DepositAssetInput {
  /** Asset symbol as listed in the supported-assets registry (case-insensitive). */
  symbol: string;
  /** Amount to deposit, expressed in stroops (integer string). */
  amountInStroops: string;
}

export type DepositRouteAction = "direct" | "convert";

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

function sumStroops(values: string[]): string {
  return values
    .reduce((acc, v) => acc + (/^\d+$/.test(v) ? BigInt(v) : BigInt(0)), BigInt(0))
    .toString();
}

/**
 * Compute a deposit routing recommendation for a multi-asset basket.
 *
 * Pure with respect to its inputs aside from the injected registry / quote /
 * fee services, which keeps it straightforward to unit test.
 */
export async function recommendDepositRouting(
  inputs: DepositAssetInput[]
): Promise<DepositRoutingResult> {
  const payload = getZapSupportedAssetsPayload();
  const vaultToken = payload.vaultToken;

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

    const quote = await getZapQuote({
      inputTokenContract: asset.contractId,
      vaultTokenContract: vaultToken.contractId,
      amountInStroops: input.amountInStroops,
      inputDecimals: asset.decimals,
      vaultDecimals: vaultToken.decimals,
    });
    conversions += 1;

    routes.push({
      symbol: asset.symbol,
      amountInStroops: input.amountInStroops,
      action: "convert",
      path: quote.path,
      expectedVaultAmountStroops: quote.amountOutAfterSlippage,
      slippageApplied: quote.slippageApplied,
      source: quote.source,
      reasoning: `${asset.symbol} converted to ${vaultToken.symbol} via a ${quote.path.length}-hop route (source: ${quote.source}, slippage ${quote.slippageApplied}).`,
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
