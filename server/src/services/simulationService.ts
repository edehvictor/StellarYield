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

// ── Rebalance Backtest Engine ─────────────────────────────────────────────
//
// Simulates a historical rebalancing strategy (schedule or drift-threshold
// based) day-by-day and compares against a passive hold benchmark.
// Fully deterministic — same inputs always produce the same outputs.

export interface RebalanceAllocationRule {
  label: string;
  targetWeight: number;   // 0-100, must sum to ~100 across all allocations
  apy: number;            // annual %, e.g. 10 = 10%
  liquidityUsd?: number;  // optional, for context only
}

export interface RebalanceBacktestParams {
  initialValueUsd: number;
  startDate: string;               // "YYYY-MM-DD"
  endDate: string;                 // "YYYY-MM-DD"
  allocations: RebalanceAllocationRule[];
  strategy: 'schedule' | 'threshold';
  rebalanceIntervalDays?: number;  // for schedule (default 30)
  driftThresholdPct?: number;      // for threshold: max allowed weight drift (default 5)
  feeBps?: number;                 // rebalance turnover fee in bps (default 20)
}

export interface RebalanceBacktestSnapshot {
  date: string;
  portfolioValue: number;   // rebalanced portfolio
  passiveValue: number;     // passive benchmark (never rebalanced)
  rebalanced: boolean;
  blendedApyPct: number;   // weighted APY of current allocation
}

export interface RebalanceEvent {
  date: string;
  reason: string;
  maxDriftPct: number;
  feeUsd: number;
}

export interface RebalanceBacktestResult {
  isSimulationOnly: true;
  startDate: string;
  endDate: string;
  initialValueUsd: number;
  finalPortfolioValue: number;
  finalPassiveValue: number;
  portfolioReturnPct: number;
  passiveReturnPct: number;
  outperformancePct: number;    // portfolio - passive return, expressed as % of initial
  rebalanceCount: number;
  totalFeesUsd: number;
  snapshots: RebalanceBacktestSnapshot[];
  rebalanceEvents: RebalanceEvent[];
}

export const BACKTEST_LIMITS = {
  maxDays: 1825,      // 5 years
  maxAllocations: 20,
} as const;

/**
 * Validate backtest params. Returns array of error strings; empty means valid.
 */
export function validateRebalanceBacktestParams(params: RebalanceBacktestParams): string[] {
  const errors: string[] = [];

  if (!params.startDate || !params.endDate) {
    errors.push("startDate and endDate are required.");
  } else {
    const start = new Date(params.startDate);
    const end = new Date(params.endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      errors.push("startDate and endDate must be valid ISO date strings.");
    } else if (start >= end) {
      errors.push("startDate must be before endDate.");
    } else {
      const dayDiff = Math.round((end.getTime() - start.getTime()) / 86_400_000);
      if (dayDiff > BACKTEST_LIMITS.maxDays) {
        errors.push(`Date range exceeds maximum of ${BACKTEST_LIMITS.maxDays} days.`);
      }
    }
  }

  if (!Number.isFinite(params.initialValueUsd) || params.initialValueUsd <= 0) {
    errors.push("initialValueUsd must be a positive number.");
  }

  if (!Array.isArray(params.allocations) || params.allocations.length === 0) {
    errors.push("allocations must be a non-empty array.");
    return errors;
  }

  if (params.allocations.length > BACKTEST_LIMITS.maxAllocations) {
    errors.push(`Too many allocations (max ${BACKTEST_LIMITS.maxAllocations}).`);
  }

  let weightSum = 0;
  for (const alloc of params.allocations) {
    if (!alloc.label) errors.push("Each allocation must have a label.");
    if (!Number.isFinite(alloc.targetWeight) || alloc.targetWeight < 0 || alloc.targetWeight > 100) {
      errors.push(`targetWeight for "${alloc.label || 'allocation'}" must be 0-100.`);
    }
    if (!Number.isFinite(alloc.apy) || alloc.apy < 0) {
      errors.push(`apy for "${alloc.label || 'allocation'}" must be a non-negative number.`);
    }
    weightSum += alloc.targetWeight;
  }

  if (Math.abs(weightSum - 100) > 0.5) {
    errors.push(`targetWeights must sum to 100 (got ${round2(weightSum)}).`);
  }

  if (params.strategy !== 'schedule' && params.strategy !== 'threshold') {
    errors.push("strategy must be 'schedule' or 'threshold'.");
  }

  return errors;
}

/**
 * Run a deterministic historical rebalance backtest.
 * @throws Error when params fail validation.
 */
export function runRebalanceBacktest(params: RebalanceBacktestParams): RebalanceBacktestResult {
  const errors = validateRebalanceBacktestParams(params);
  if (errors.length > 0) {
    throw new Error(`Invalid backtest parameters: ${errors.join(" ")}`);
  }

  const feeBps = params.feeBps ?? 20;
  const rebalanceIntervalDays = params.rebalanceIntervalDays ?? 30;
  const driftThresholdPct = params.driftThresholdPct ?? 5;

  const targetWeights = params.allocations.map(a => a.targetWeight / 100);
  const dailyFactors = params.allocations.map(a => 1 + (a.apy / 100) / 365);

  // Per-allocation values for the rebalanced portfolio and the passive benchmark
  let portfolioAlloc = targetWeights.map(w => params.initialValueUsd * w);
  let passiveAlloc = [...portfolioAlloc];

  const snapshots: RebalanceBacktestSnapshot[] = [];
  const rebalanceEvents: RebalanceEvent[] = [];
  let totalFeesUsd = 0;
  let dayNumber = 0;

  const startMs = new Date(params.startDate).getTime();
  const endMs = new Date(params.endDate).getTime();

  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const dateStr = new Date(ms).toISOString().slice(0, 10);

    // Compound growth for each allocation
    portfolioAlloc = portfolioAlloc.map((v, i) => v * dailyFactors[i]);
    passiveAlloc = passiveAlloc.map((v, i) => v * dailyFactors[i]);

    const totalPortfolio = portfolioAlloc.reduce((s, v) => s + v, 0);
    const currentWeights = portfolioAlloc.map(v => (v / totalPortfolio) * 100);

    // Determine whether a rebalance should occur today
    let shouldRebalance = false;
    let rebalanceReason = '';
    let maxDrift = 0;

    if (params.strategy === 'schedule') {
      if (dayNumber > 0 && dayNumber % rebalanceIntervalDays === 0) {
        shouldRebalance = true;
        rebalanceReason = `Scheduled rebalance every ${rebalanceIntervalDays} days`;
      }
    } else {
      const drifts = params.allocations.map((a, i) =>
        Math.abs(currentWeights[i] - a.targetWeight),
      );
      maxDrift = Math.max(...drifts);
      if (maxDrift > driftThresholdPct) {
        shouldRebalance = true;
        rebalanceReason = `Max weight drift ${round2(maxDrift)}% exceeded ${driftThresholdPct}% threshold`;
      }
    }

    let feeToday = 0;
    if (shouldRebalance) {
      const targetValues = targetWeights.map(w => totalPortfolio * w);
      const grossMovement = portfolioAlloc.reduce(
        (s, v, i) => s + Math.abs(v - targetValues[i]),
        0,
      );
      const turnover = grossMovement / 2;
      feeToday = (turnover * feeBps) / 10_000;
      totalFeesUsd += feeToday;

      const valueAfterFee = totalPortfolio - feeToday;
      portfolioAlloc = targetWeights.map(w => valueAfterFee * w);

      rebalanceEvents.push({
        date: dateStr,
        reason: rebalanceReason,
        maxDriftPct: round2(maxDrift),
        feeUsd: round2(feeToday),
      });
    }

    const portfolioTotal = portfolioAlloc.reduce((s, v) => s + v, 0);
    const passiveTotal = passiveAlloc.reduce((s, v) => s + v, 0);
    const blendedApy = params.allocations.reduce(
      (sum, a, i) => sum + a.apy * (portfolioAlloc[i] / portfolioTotal),
      0,
    );

    snapshots.push({
      date: dateStr,
      portfolioValue: round2(portfolioTotal),
      passiveValue: round2(passiveTotal),
      rebalanced: shouldRebalance,
      blendedApyPct: round2(blendedApy),
    });

    dayNumber++;
  }

  const last = snapshots[snapshots.length - 1];
  const finalPortfolio = last?.portfolioValue ?? params.initialValueUsd;
  const finalPassive = last?.passiveValue ?? params.initialValueUsd;
  const init = params.initialValueUsd;

  return {
    isSimulationOnly: true,
    startDate: params.startDate,
    endDate: params.endDate,
    initialValueUsd: init,
    finalPortfolioValue: round2(finalPortfolio),
    finalPassiveValue: round2(finalPassive),
    portfolioReturnPct: round2(((finalPortfolio - init) / init) * 100),
    passiveReturnPct: round2(((finalPassive - init) / init) * 100),
    outperformancePct: round2(((finalPortfolio - finalPassive) / init) * 100),
    rebalanceCount: rebalanceEvents.length,
    totalFeesUsd: round2(totalFeesUsd),
    snapshots,
    rebalanceEvents,
  };
}
