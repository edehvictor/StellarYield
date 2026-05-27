/**
 * POST /api/wizard/recommend
 *
 * Accepts a risk profile from the multi-step deposit wizard and returns
 * ranked vault suggestions with explanations.
 *
 * Body:
 *   profile      — "conservative" | "balanced" | "aggressive"
 *   timeHorizon  — "short" | "medium" | "long"
 *   liquidity    — "high" | "medium" | "low"
 */
import { Router, Request, Response } from "express";
import {
  rankStrategies,
  StrategyInput,
} from "../services/riskAdjustedYieldService";
import { DrawdownToleranceProfile } from "../services/drawdownService";

const router = Router();

// Map wizard "aggressive" to the internal "tolerant" profile
function toDrawdownProfile(profile: string): DrawdownToleranceProfile {
  if (profile === "conservative") return "conservative";
  if (profile === "aggressive") return "tolerant";
  return "balanced";
}

// Liquidity multiplier: high-liquidity users prefer lower-volatility vaults
function liquidityPenalty(liquidity: string, ilVolatilityPct: number): number {
  if (liquidity === "high") return ilVolatilityPct > 10 ? 0.7 : 1.0;
  if (liquidity === "low") return 1.0;
  return ilVolatilityPct > 20 ? 0.85 : 1.0;
}

// Time-horizon multiplier: short-horizon users penalise low-TVL vaults
function horizonMultiplier(timeHorizon: string, tvlUsd: number): number {
  if (timeHorizon === "short") return tvlUsd < 100_000 ? 0.8 : 1.0;
  if (timeHorizon === "long") return 1.0;
  return tvlUsd < 50_000 ? 0.9 : 1.0;
}

function buildExplanation(
  strategy: StrategyInput & { rank: number; riskAdjustedYield: number },
  profile: string,
  timeHorizon: string,
  liquidity: string,
): string {
  const parts: string[] = [];
  parts.push(
    `Ranked #${strategy.rank} for a ${profile} profile with ${timeHorizon} time horizon.`,
  );
  parts.push(
    `APY ${strategy.apy.toFixed(2)}% adjusted to ${strategy.riskAdjustedYield.toFixed(4)} after risk scoring (${strategy.riskScore}/10).`,
  );
  if (liquidity === "high" && strategy.ilVolatilityPct > 10) {
    parts.push(
      "IL volatility is elevated; a liquidity discount was applied because you need quick access.",
    );
  }
  if (timeHorizon === "short" && strategy.tvlUsd < 100_000) {
    parts.push(
      "TVL is relatively low; a short-horizon penalty was applied to favour deeper liquidity.",
    );
  }
  return parts.join(" ");
}

// Seed strategies (in production these would come from the yield service)
const SEED_STRATEGIES: StrategyInput[] = [
  {
    id: "blend",
    name: "Blend USDC Vault",
    strategyType: "blend",
    apy: 8.5,
    tvlUsd: 2_500_000,
    ilVolatilityPct: 3,
    riskScore: 8,
    fetchedAt: new Date().toISOString(),
    historicalDepthDays: 365,
  },
  {
    id: "soroswap-xlm-usdc",
    name: "Soroswap XLM/USDC LP",
    strategyType: "soroswap",
    apy: 18.2,
    tvlUsd: 800_000,
    ilVolatilityPct: 22,
    riskScore: 5,
    fetchedAt: new Date().toISOString(),
    historicalDepthDays: 180,
  },
  {
    id: "defindex-stable",
    name: "DeFindex Stable Basket",
    strategyType: "defindex",
    apy: 6.1,
    tvlUsd: 4_200_000,
    ilVolatilityPct: 1.5,
    riskScore: 9,
    fetchedAt: new Date().toISOString(),
    historicalDepthDays: 365,
  },
  {
    id: "soroswap-aqua-xlm",
    name: "Soroswap AQUA/XLM LP",
    strategyType: "soroswap",
    apy: 34.7,
    tvlUsd: 320_000,
    ilVolatilityPct: 45,
    riskScore: 3,
    fetchedAt: new Date().toISOString(),
    historicalDepthDays: 90,
  },
  {
    id: "blend-xlm",
    name: "Blend XLM Vault",
    strategyType: "blend",
    apy: 11.3,
    tvlUsd: 1_100_000,
    ilVolatilityPct: 8,
    riskScore: 7,
    fetchedAt: new Date().toISOString(),
    historicalDepthDays: 270,
  },
];

router.post("/recommend", (req: Request, res: Response): void => {
  const { profile = "balanced", timeHorizon = "medium", liquidity = "medium" } =
    req.body as {
      profile?: string;
      timeHorizon?: string;
      liquidity?: string;
    };

  const validProfiles = ["conservative", "balanced", "aggressive"];
  const validHorizons = ["short", "medium", "long"];
  const validLiquidity = ["high", "medium", "low"];

  if (
    !validProfiles.includes(profile) ||
    !validHorizons.includes(timeHorizon) ||
    !validLiquidity.includes(liquidity)
  ) {
    res.status(400).json({ error: "Invalid wizard parameters." });
    return;
  }

  const drawdownProfile = toDrawdownProfile(profile);

  // Apply liquidity and horizon adjustments to a copy of the seed strategies
  const adjusted = SEED_STRATEGIES.map((s) => ({
    ...s,
    apy:
      s.apy *
      liquidityPenalty(liquidity, s.ilVolatilityPct) *
      horizonMultiplier(timeHorizon, s.tvlUsd),
  }));

  const ranked = rankStrategies(adjusted, drawdownProfile);

  const recommendations = ranked.slice(0, 3).map((s) => ({
    rank: s.rank,
    id: s.id,
    name: s.name,
    strategyType: s.strategyType,
    apy: SEED_STRATEGIES.find((x) => x.id === s.id)!.apy, // original APY
    tvlUsd: s.tvlUsd,
    riskScore: s.riskScore,
    riskAdjustedYield: s.riskAdjustedYield,
    ilVolatilityPct: s.ilVolatilityPct,
    explanation: buildExplanation(s, profile, timeHorizon, liquidity),
  }));

  res.json({ profile, timeHorizon, liquidity, recommendations });
});

export default router;
