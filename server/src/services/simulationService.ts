import { PROTOCOLS } from "../config/protocols";

export interface SimulationParams {
  strategyId: string;
  amount: number;
  token: string;
}

export interface SimulationAllocation {
  protocol: string;
  amount: number;
  percentage: number;
}

export interface SimulationFee {
  type: string;
  amount: number;
}

export interface SimulationResult {
  isSimulationOnly: true;
  allocations: SimulationAllocation[];
  expectedShares: number;
  fees: SimulationFee[];
  postDepositExposure: {
    expectedApy: number;
  };
  routing: {
    path: string[];
    expectedOutput: number;
  };
  warnings: string[];
}

export function simulateDeposit(params: SimulationParams): SimulationResult {
  const { amount, strategyId, token: _token } = params;

  // We explicitly mark this as simulation-only
  const result: SimulationResult = {
    isSimulationOnly: true,
    allocations: [],
    expectedShares: 0,
    fees: [],
    postDepositExposure: { expectedApy: 0 },
    routing: { path: [], expectedOutput: 0 },
    warnings: [],
  };

  if (amount <= 0) {
    result.warnings.push("Amount must be greater than zero.");
    return result;
  }

  // Fees
  // Base deposit fee (e.g. 0.1%)
  const entryFee = amount * 0.001;
  result.fees.push({ type: "Entry Fee", amount: entryFee });
  
  // Gas estimate
  const networkFee = 0.05; // 0.05 units of token/XLM
  result.fees.push({ type: "Network Fee Estimate", amount: networkFee });
  
  const netAmount = amount - entryFee;

  // Illiquidity / Slippage warnings
  if (amount > 100000) {
    result.warnings.push("High slippage expected for deposits over 100k.");
  }
  
  if (amount > 1000000) {
    result.warnings.push("Insufficient liquidity to route this deposit fully.");
  }

  let targetProtocols = PROTOCOLS.filter((p) => p.protocolType === "blend");
  let baseApySum = targetProtocols.reduce((acc, p) => acc + p.baseApyBps, 0);

  if (strategyId.toLowerCase().includes("aggressive")) {
    targetProtocols = PROTOCOLS.filter((p) => p.protocolType !== "blend");
    baseApySum = targetProtocols.reduce((acc, p) => acc + p.baseApyBps, 0) || 1000;
  }

  if (targetProtocols.length === 0) {
     result.warnings.push("Unsupported strategy or asset combination.");
     targetProtocols = [PROTOCOLS[0]]; // fallback
     baseApySum = targetProtocols[0].baseApyBps;
  }

  // Allocate proportionally based on APY (just a mock logic for simulation)
  let allocated = 0;
  let blendedApyBps = 0;

  targetProtocols.forEach((p, index) => {
    let allocAmount = 0;
    if (index === targetProtocols.length - 1) {
       allocAmount = netAmount - allocated;
    } else {
       allocAmount = netAmount * (p.baseApyBps / baseApySum);
    }
    allocated += allocAmount;
    
    // Weight APY
    blendedApyBps += (p.baseApyBps * allocAmount) / netAmount;

    result.allocations.push({
      protocol: p.protocolName,
      amount: allocAmount,
      percentage: (allocAmount / amount) * 100, // percentage of *base* amount for clarity
    });
    
    result.routing.path.push(p.protocolName);
  });

  result.postDepositExposure.expectedApy = blendedApyBps / 100;

  // Assuming 1 token = 1 share for simplicity, with some small slippage loss mock
  const slippageLoss = amount > 100000 ? netAmount * 0.01 : netAmount * 0.001;
  result.expectedShares = netAmount - slippageLoss;
  result.routing.expectedOutput = result.expectedShares;

  return result;
}

// ── Rebalance Simulation Sandbox ────────────────────────────────────────
//
// Previews the effect of moving from a current allocation to a target
// allocation before any capital is committed: projected blended APY,
// estimated turnover fees, and per-leg allocation drift, plus warnings for
// high fees, stale data, and liquidity risk. Simulation-only — it never
// executes a rebalance.

export interface RebalanceAllocationInput {
  label: string; // protocol / vault name
  currentWeight: number; // 0-100, current share of the portfolio
  targetWeight: number; // 0-100, desired share of the portfolio
  apy: number; // annualized %, used for blended APY
  liquidityUsd?: number; // available liquidity for this leg
}

export interface RebalanceParams {
  totalValueUsd: number;
  allocations: RebalanceAllocationInput[];
  feeBps?: number; // turnover fee in bps (default 20 = 0.2%)
  dataAgeSeconds?: number; // age of the market data feeding the preview
}

export interface RebalanceLeg {
  label: string;
  currentWeight: number;
  targetWeight: number;
  driftPct: number; // targetWeight - currentWeight (signed)
  currentValueUsd: number;
  targetValueUsd: number;
  deltaUsd: number; // targetValue - currentValue (signed)
}

export interface RebalancePreview {
  isSimulationOnly: true;
  legs: RebalanceLeg[];
  blendedApyBefore: number;
  blendedApyAfter: number;
  apyDeltaPct: number;
  totalTurnoverUsd: number; // capital that actually moves
  estimatedFeeUsd: number;
  maxDriftPct: number; // largest absolute drift across legs
  warnings: string[];
}

export const REBALANCE_THRESHOLDS = {
  defaultFeeBps: 20, // 0.2%
  /** Warn when estimated fees exceed this fraction of portfolio value. */
  highFeeRatio: 0.005, // 0.5%
  /** Data older than this (seconds) is considered stale. */
  staleDataSeconds: 30 * 60,
  /** Warn when a buy leg consumes more than this fraction of its liquidity. */
  liquidityUtilizationLimit: 0.5,
  /** Weights are valid when their sum is within this tolerance of 100. */
  weightSumTolerance: 0.5,
} as const;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Validate rebalance inputs. Returns a list of human-readable errors; an
 * empty array means the params are valid.
 */
export function validateRebalanceParams(params: RebalanceParams): string[] {
  const errors: string[] = [];
  const t = REBALANCE_THRESHOLDS;

  if (!Number.isFinite(params.totalValueUsd) || params.totalValueUsd <= 0) {
    errors.push("totalValueUsd must be a positive number.");
  }

  if (!Array.isArray(params.allocations) || params.allocations.length === 0) {
    errors.push("allocations must be a non-empty array.");
    return errors;
  }

  if (
    params.feeBps !== undefined &&
    (!Number.isFinite(params.feeBps) || params.feeBps < 0)
  ) {
    errors.push("feeBps must be a non-negative number.");
  }

  let currentSum = 0;
  let targetSum = 0;
  for (const alloc of params.allocations) {
    if (!alloc.label) {
      errors.push("Each allocation needs a label.");
    }
    for (const [field, value] of [
      ["currentWeight", alloc.currentWeight],
      ["targetWeight", alloc.targetWeight],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        errors.push(
          `${field} for ${alloc.label || "allocation"} must be between 0 and 100.`,
        );
      }
    }
    currentSum += alloc.currentWeight;
    targetSum += alloc.targetWeight;
  }

  if (Math.abs(currentSum - 100) > t.weightSumTolerance) {
    errors.push(`Current weights must sum to 100% (got ${round2(currentSum)}%).`);
  }
  if (Math.abs(targetSum - 100) > t.weightSumTolerance) {
    errors.push(`Target weights must sum to 100% (got ${round2(targetSum)}%).`);
  }

  return errors;
}

/**
 * Preview the effect of rebalancing from current to target allocations.
 * @throws Error when params fail validation.
 */
export function simulateRebalance(params: RebalanceParams): RebalancePreview {
  const errors = validateRebalanceParams(params);
  if (errors.length > 0) {
    throw new Error(`Invalid rebalance parameters: ${errors.join(" ")}`);
  }

  const t = REBALANCE_THRESHOLDS;
  const { totalValueUsd, allocations } = params;
  const feeBps = params.feeBps ?? t.defaultFeeBps;

  let blendedApyBefore = 0;
  let blendedApyAfter = 0;
  let maxDriftPct = 0;
  let grossMovement = 0;
  const warnings: string[] = [];

  const legs: RebalanceLeg[] = allocations.map((alloc) => {
    const currentValueUsd = (totalValueUsd * alloc.currentWeight) / 100;
    const targetValueUsd = (totalValueUsd * alloc.targetWeight) / 100;
    const deltaUsd = targetValueUsd - currentValueUsd;
    const driftPct = alloc.targetWeight - alloc.currentWeight;

    blendedApyBefore += (alloc.apy * alloc.currentWeight) / 100;
    blendedApyAfter += (alloc.apy * alloc.targetWeight) / 100;
    maxDriftPct = Math.max(maxDriftPct, Math.abs(driftPct));
    grossMovement += Math.abs(deltaUsd);

    // Liquidity risk: a buy leg that consumes too much of its available pool.
    if (
      deltaUsd > 0 &&
      alloc.liquidityUsd !== undefined &&
      alloc.liquidityUsd >= 0 &&
      deltaUsd > alloc.liquidityUsd * t.liquidityUtilizationLimit
    ) {
      warnings.push(
        `Liquidity risk: rebalancing into ${alloc.label} moves $${round2(deltaUsd)} against $${round2(alloc.liquidityUsd)} of liquidity.`,
      );
    }

    return {
      label: alloc.label,
      currentWeight: round2(alloc.currentWeight),
      targetWeight: round2(alloc.targetWeight),
      driftPct: round2(driftPct),
      currentValueUsd: round2(currentValueUsd),
      targetValueUsd: round2(targetValueUsd),
      deltaUsd: round2(deltaUsd),
    };
  });

  // Capital that actually moves is half the gross movement (buys == sells).
  const totalTurnoverUsd = grossMovement / 2;
  const estimatedFeeUsd = (totalTurnoverUsd * feeBps) / 10000;

  if (estimatedFeeUsd > totalValueUsd * t.highFeeRatio) {
    warnings.push(
      `High fees: estimated rebalance cost $${round2(estimatedFeeUsd)} exceeds ${t.highFeeRatio * 100}% of portfolio value.`,
    );
  }

  if (
    params.dataAgeSeconds !== undefined &&
    params.dataAgeSeconds > t.staleDataSeconds
  ) {
    warnings.push(
      `Stale data: preview uses market data ${Math.round(params.dataAgeSeconds / 60)}m old; refresh before committing.`,
    );
  }

  return {
    isSimulationOnly: true,
    legs,
    blendedApyBefore: round2(blendedApyBefore),
    blendedApyAfter: round2(blendedApyAfter),
    apyDeltaPct: round2(blendedApyAfter - blendedApyBefore),
    totalTurnoverUsd: round2(totalTurnoverUsd),
    estimatedFeeUsd: round2(estimatedFeeUsd),
    maxDriftPct: round2(maxDriftPct),
    warnings,
  };
}
