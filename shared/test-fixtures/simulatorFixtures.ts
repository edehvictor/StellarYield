/**
 * Shared simulator test fixtures for client and server tests.
 * These canonical fixtures ensure client and server simulator logic remains in sync.
 */

export interface SimulatorFixture {
  description: string;
  input: {
    strategyId: string;
    amount: number;
    token: string;
  };
  expectedOutput: {
    // Fee expectations
    hasEntryFee: boolean;
    hasNetworkFee: boolean;
    expectedFeesLength: number;
    
    // Allocation expectations
    minAllocations: number;
    allAllocationsPositive: boolean;
    allocationsSum: number; // should equal (amount - entryFee)
    
    // Share expectations
    expectedSharesLessThanNetAmount: boolean;
    
    // APY expectations
    expectedApyRange: { min: number; max: number };
    
    // Warnings
    expectedWarnings: {
      highSlippage?: boolean;
      insufficientLiquidity?: boolean;
      unsupported?: boolean;
    };
    
    // Routing
    hasValidRoutingPath: boolean;
  };
}

/**
 * Canonical simulator test fixtures.
 * These represent typical usage patterns and edge cases.
 */
export const SIMULATOR_FIXTURES: SimulatorFixture[] = [
  {
    description: "Basic small deposit (1000 units)",
    input: {
      strategyId: "blend-stable",
      amount: 1000,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: true,
      hasNetworkFee: true,
      expectedFeesLength: 2,
      minAllocations: 1,
      allAllocationsPositive: true,
      allocationsSum: 999, // ~1000 - 1 entry fee (0.1%)
      expectedSharesLessThanNetAmount: true,
      expectedApyRange: { min: 1, max: 30 },
      expectedWarnings: {
        highSlippage: false,
        insufficientLiquidity: false,
        unsupported: false,
      },
      hasValidRoutingPath: true,
    },
  },
  {
    description: "Medium deposit (50000 units)",
    input: {
      strategyId: "blend-stable",
      amount: 50000,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: true,
      hasNetworkFee: true,
      expectedFeesLength: 2,
      minAllocations: 1,
      allAllocationsPositive: true,
      allocationsSum: 49950, // ~50000 - 50 entry fee
      expectedSharesLessThanNetAmount: true,
      expectedApyRange: { min: 1, max: 30 },
      expectedWarnings: {
        highSlippage: false,
        insufficientLiquidity: false,
        unsupported: false,
      },
      hasValidRoutingPath: true,
    },
  },
  {
    description: "Large deposit with high slippage warning (150000 units)",
    input: {
      strategyId: "blend-stable",
      amount: 150000,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: true,
      hasNetworkFee: true,
      expectedFeesLength: 2,
      minAllocations: 1,
      allAllocationsPositive: true,
      allocationsSum: 149850, // ~150000 - 150 entry fee
      expectedSharesLessThanNetAmount: true,
      expectedApyRange: { min: 1, max: 30 },
      expectedWarnings: {
        highSlippage: true, // Over 100k triggers slippage warning
        insufficientLiquidity: false,
        unsupported: false,
      },
      hasValidRoutingPath: true,
    },
  },
  {
    description: "Very large deposit with liquidity warning (2000000 units)",
    input: {
      strategyId: "blend-stable",
      amount: 2000000,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: true,
      hasNetworkFee: true,
      expectedFeesLength: 2,
      minAllocations: 1,
      allAllocationsPositive: true,
      allocationsSum: 1998000, // ~2000000 - 2000 entry fee
      expectedSharesLessThanNetAmount: true,
      expectedApyRange: { min: 1, max: 30 },
      expectedWarnings: {
        highSlippage: true,
        insufficientLiquidity: true, // Over 1M triggers liquidity warning
        unsupported: false,
      },
      hasValidRoutingPath: true,
    },
  },
  {
    description: "Aggressive strategy deposit (50000 units)",
    input: {
      strategyId: "aggressive-yield",
      amount: 50000,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: true,
      hasNetworkFee: true,
      expectedFeesLength: 2,
      minAllocations: 1,
      allAllocationsPositive: true,
      allocationsSum: 49950,
      expectedSharesLessThanNetAmount: true,
      expectedApyRange: { min: 1, max: 50 }, // Aggressive may have higher APY
      expectedWarnings: {
        highSlippage: false,
        insufficientLiquidity: false,
        unsupported: false,
      },
      hasValidRoutingPath: true,
    },
  },
  {
    description: "Minimum viable deposit (10 units)",
    input: {
      strategyId: "blend-stable",
      amount: 10,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: true,
      hasNetworkFee: true,
      expectedFeesLength: 2,
      minAllocations: 1,
      allAllocationsPositive: true,
      allocationsSum: 10 - 0.01, // ~10 - 0.01 entry fee
      expectedSharesLessThanNetAmount: true,
      expectedApyRange: { min: 0, max: 30 },
      expectedWarnings: {
        highSlippage: false,
        insufficientLiquidity: false,
        unsupported: false,
      },
      hasValidRoutingPath: true,
    },
  },
];

/**
 * Test inputs that should produce warnings or errors.
 */
export const SIMULATOR_EDGE_CASES: SimulatorFixture[] = [
  {
    description: "Zero deposit amount",
    input: {
      strategyId: "blend-stable",
      amount: 0,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: false,
      hasNetworkFee: false,
      expectedFeesLength: 0,
      minAllocations: 0,
      allAllocationsPositive: true,
      allocationsSum: 0,
      expectedSharesLessThanNetAmount: false,
      expectedApyRange: { min: 0, max: 0 },
      expectedWarnings: {
        unsupported: true, // Amount must be > 0
      },
      hasValidRoutingPath: false,
    },
  },
  {
    description: "Negative deposit amount",
    input: {
      strategyId: "blend-stable",
      amount: -1000,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: false,
      hasNetworkFee: false,
      expectedFeesLength: 0,
      minAllocations: 0,
      allAllocationsPositive: true,
      allocationsSum: 0,
      expectedSharesLessThanNetAmount: false,
      expectedApyRange: { min: 0, max: 0 },
      expectedWarnings: {
        unsupported: true, // Amount must be > 0
      },
      hasValidRoutingPath: false,
    },
  },
  {
    description: "Unsupported strategy",
    input: {
      strategyId: "unknown-strategy-xyz",
      amount: 50000,
      token: "USDC",
    },
    expectedOutput: {
      hasEntryFee: true,
      hasNetworkFee: true,
      expectedFeesLength: 2,
      minAllocations: 1,
      allAllocationsPositive: true,
      allocationsSum: 49950,
      expectedSharesLessThanNetAmount: true,
      expectedApyRange: { min: 0, max: 30 },
      expectedWarnings: {
        unsupported: true,
      },
      hasValidRoutingPath: true,
    },
  },
];

/**
 * Helper to validate a simulation result against fixture expectations
 */
// ── Rebalance Fixtures ──────────────────────────────────────────────────

export interface RebalanceFixture {
  description: string;
  input: {
    totalValueUsd: number;
    allocations: {
      label: string;
      currentWeight: number;
      targetWeight: number;
      apy: number;
      liquidityUsd?: number;
    }[];
    feeBps?: number;
    dataAgeSeconds?: number;
  };
  expectedOutput: {
    legCount: number;
    blendedApyBeforePositive: boolean;
    blendedApyAfterPositive: boolean;
    apyDeltaSign: 'positive' | 'negative' | 'zero';
    totalTurnoverPositive: boolean;
    estimatedFeePositive: boolean;
    maxDriftPctMin: number;
    expectedWarnings: {
      highFees?: boolean;
      staleData?: boolean;
      liquidityRisk?: boolean;
    };
  };
}

export const REBALANCE_FIXTURES: RebalanceFixture[] = [
  {
    description: 'Balanced two-leg rebalance with no warnings',
    input: {
      totalValueUsd: 100_000,
      allocations: [
        { label: 'Blend-A', currentWeight: 60, targetWeight: 50, apy: 8, liquidityUsd: 500_000 },
        { label: 'Blend-B', currentWeight: 40, targetWeight: 50, apy: 12, liquidityUsd: 500_000 },
      ],
    },
    expectedOutput: {
      legCount: 2,
      blendedApyBeforePositive: true,
      blendedApyAfterPositive: true,
      apyDeltaSign: 'positive',
      totalTurnoverPositive: true,
      estimatedFeePositive: true,
      maxDriftPctMin: 10,
      expectedWarnings: {},
    },
  },
  {
    description: 'Three-leg rebalance shifting to higher APY',
    input: {
      totalValueUsd: 250_000,
      allocations: [
        { label: 'Stable', currentWeight: 50, targetWeight: 20, apy: 4, liquidityUsd: 1_000_000 },
        { label: 'Moderate', currentWeight: 30, targetWeight: 40, apy: 10, liquidityUsd: 1_000_000 },
        { label: 'Aggressive', currentWeight: 20, targetWeight: 40, apy: 18, liquidityUsd: 1_000_000 },
      ],
    },
    expectedOutput: {
      legCount: 3,
      blendedApyBeforePositive: true,
      blendedApyAfterPositive: true,
      apyDeltaSign: 'positive',
      totalTurnoverPositive: true,
      estimatedFeePositive: true,
      maxDriftPctMin: 20,
      expectedWarnings: {},
    },
  },
  {
    description: 'Rebalance with stale data warning',
    input: {
      totalValueUsd: 50_000,
      allocations: [
        { label: 'Pool-X', currentWeight: 70, targetWeight: 50, apy: 6 },
        { label: 'Pool-Y', currentWeight: 30, targetWeight: 50, apy: 14 },
      ],
      dataAgeSeconds: 3600,
    },
    expectedOutput: {
      legCount: 2,
      blendedApyBeforePositive: true,
      blendedApyAfterPositive: true,
      apyDeltaSign: 'positive',
      totalTurnoverPositive: true,
      estimatedFeePositive: true,
      maxDriftPctMin: 20,
      expectedWarnings: { staleData: true },
    },
  },
  {
    description: 'Rebalance with liquidity risk warning',
    input: {
      totalValueUsd: 200_000,
      allocations: [
        { label: 'Liquid', currentWeight: 80, targetWeight: 30, apy: 5, liquidityUsd: 1_000_000 },
        { label: 'Illiquid', currentWeight: 20, targetWeight: 70, apy: 20, liquidityUsd: 50_000 },
      ],
    },
    expectedOutput: {
      legCount: 2,
      blendedApyBeforePositive: true,
      blendedApyAfterPositive: true,
      apyDeltaSign: 'positive',
      totalTurnoverPositive: true,
      estimatedFeePositive: true,
      maxDriftPctMin: 50,
      expectedWarnings: { liquidityRisk: true },
    },
  },
];

export const REBALANCE_EDGE_CASES: RebalanceFixture[] = [
  {
    description: 'No-op rebalance (current matches target)',
    input: {
      totalValueUsd: 100_000,
      allocations: [
        { label: 'A', currentWeight: 50, targetWeight: 50, apy: 10 },
        { label: 'B', currentWeight: 50, targetWeight: 50, apy: 10 },
      ],
    },
    expectedOutput: {
      legCount: 2,
      blendedApyBeforePositive: true,
      blendedApyAfterPositive: true,
      apyDeltaSign: 'zero',
      totalTurnoverPositive: false,
      estimatedFeePositive: false,
      maxDriftPctMin: 0,
      expectedWarnings: {},
    },
  },
];

// ── Failover Fixtures ───────────────────────────────────────────────────

export interface FailoverFixture {
  description: string;
  input: {
    initialValueUsd: number;
    startDate: string;
    endDate: string;
    allocations: {
      label: string;
      targetWeight: number;
      apy: number;
    }[];
    strategy: 'schedule' | 'threshold';
    rebalanceIntervalDays?: number;
    driftThresholdPct?: number;
    feeBps?: number;
  };
  expectedOutput: {
    finalPortfolioGtInitial: boolean;
    finalPassiveGtInitial: boolean;
    rebalanceCountMin: number;
    rebalanceCountMax: number;
    snapshotCount: number;
    totalFeesPositive: boolean;
  };
}

export const FAILOVER_FIXTURES: FailoverFixture[] = [
  {
    description: 'Schedule-based 90-day backtest with monthly rebalance',
    input: {
      initialValueUsd: 100_000,
      startDate: '2025-01-01',
      endDate: '2025-03-31',
      allocations: [
        { label: 'Blend-Stable', targetWeight: 60, apy: 6 },
        { label: 'Blend-Growth', targetWeight: 40, apy: 12 },
      ],
      strategy: 'schedule',
      rebalanceIntervalDays: 30,
    },
    expectedOutput: {
      finalPortfolioGtInitial: true,
      finalPassiveGtInitial: true,
      rebalanceCountMin: 2,
      rebalanceCountMax: 3,
      snapshotCount: 90,
      totalFeesPositive: true,
    },
  },
  {
    description: 'Threshold-based 60-day backtest with 5% drift trigger',
    input: {
      initialValueUsd: 50_000,
      startDate: '2025-01-01',
      endDate: '2025-03-01',
      allocations: [
        { label: 'Low-Yield', targetWeight: 30, apy: 3 },
        { label: 'High-Yield', targetWeight: 70, apy: 25 },
      ],
      strategy: 'threshold',
      driftThresholdPct: 5,
    },
    expectedOutput: {
      finalPortfolioGtInitial: true,
      finalPassiveGtInitial: true,
      rebalanceCountMin: 0,
      rebalanceCountMax: 10,
      snapshotCount: 60,
      totalFeesPositive: false,
    },
  },
  {
    description: 'Single-allocation no-rebalance baseline',
    input: {
      initialValueUsd: 10_000,
      startDate: '2025-06-01',
      endDate: '2025-06-30',
      allocations: [
        { label: 'Solo', targetWeight: 100, apy: 8 },
      ],
      strategy: 'schedule',
      rebalanceIntervalDays: 30,
    },
    expectedOutput: {
      finalPortfolioGtInitial: true,
      finalPassiveGtInitial: true,
      rebalanceCountMin: 0,
      rebalanceCountMax: 1,
      snapshotCount: 30,
      totalFeesPositive: false,
    },
  },
];

export function validateRebalanceResult(
  fixture: RebalanceFixture,
  result: any,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const exp = fixture.expectedOutput;

  if (result.legs?.length !== exp.legCount) {
    errors.push(`Expected ${exp.legCount} legs, got ${result.legs?.length}`);
  }
  if (exp.blendedApyBeforePositive && !(result.blendedApyBefore > 0)) {
    errors.push('Expected positive blendedApyBefore');
  }
  if (exp.blendedApyAfterPositive && !(result.blendedApyAfter > 0)) {
    errors.push('Expected positive blendedApyAfter');
  }
  if (exp.apyDeltaSign === 'positive' && !(result.apyDeltaPct > 0)) {
    errors.push('Expected positive APY delta');
  }
  if (exp.apyDeltaSign === 'negative' && !(result.apyDeltaPct < 0)) {
    errors.push('Expected negative APY delta');
  }
  if (exp.apyDeltaSign === 'zero' && result.apyDeltaPct !== 0) {
    errors.push('Expected zero APY delta');
  }
  if (exp.totalTurnoverPositive && !(result.totalTurnoverUsd > 0)) {
    errors.push('Expected positive turnover');
  }
  if (!exp.totalTurnoverPositive && result.totalTurnoverUsd !== 0) {
    errors.push('Expected zero turnover');
  }
  if (exp.estimatedFeePositive && !(result.estimatedFeeUsd > 0)) {
    errors.push('Expected positive estimated fee');
  }
  if (result.maxDriftPct < exp.maxDriftPctMin) {
    errors.push(`Expected maxDriftPct >= ${exp.maxDriftPctMin}, got ${result.maxDriftPct}`);
  }

  const warnings: unknown[] = result.warnings || [];
  const hasCode = (code: string) =>
    warnings.some((w: unknown) =>
      typeof w === "object" && w !== null && (w as Record<string, unknown>).code === code
    );
  const hasText = (text: string) =>
    warnings.some((w: unknown) =>
      typeof w === "string" && w.toLowerCase().includes(text.toLowerCase())
    );

  if (exp.expectedWarnings.staleData && !hasCode("STALE_DATA") && !hasText("Stale data")) {
    errors.push('Expected stale data warning');
  }
  if (exp.expectedWarnings.liquidityRisk && !hasCode("LIQUIDITY_RISK") && !hasText("Liquidity risk")) {
    errors.push('Expected liquidity risk warning');
  }
  if (exp.expectedWarnings.highFees && !hasCode("HIGH_FEES") && !hasText("High fees")) {
    errors.push('Expected high fees warning');
  }

  return { valid: errors.length === 0, errors };
}

export function validateFailoverResult(
  fixture: FailoverFixture,
  result: any,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const exp = fixture.expectedOutput;

  if (exp.finalPortfolioGtInitial && !(result.finalPortfolioValue > fixture.input.initialValueUsd)) {
    errors.push('Expected final portfolio > initial value');
  }
  if (exp.finalPassiveGtInitial && !(result.finalPassiveValue > fixture.input.initialValueUsd)) {
    errors.push('Expected final passive > initial value');
  }
  if (result.rebalanceCount < exp.rebalanceCountMin) {
    errors.push(`Expected >= ${exp.rebalanceCountMin} rebalances, got ${result.rebalanceCount}`);
  }
  if (result.rebalanceCount > exp.rebalanceCountMax) {
    errors.push(`Expected <= ${exp.rebalanceCountMax} rebalances, got ${result.rebalanceCount}`);
  }
  if (exp.totalFeesPositive && !(result.totalFeesUsd > 0)) {
    errors.push('Expected positive total fees');
  }

  return { valid: errors.length === 0, errors };
}

export function validateSimulationResult(
  fixture: SimulatorFixture,
  result: any,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check fees
  if (fixture.expectedOutput.hasEntryFee) {
    const hasEntryFee = result.fees?.some((f: any) => f.type === "Entry Fee");
    if (!hasEntryFee) {
      errors.push("Expected Entry Fee not found");
    }
  }

  if (fixture.expectedOutput.hasNetworkFee) {
    const hasNetworkFee = result.fees?.some((f: any) => f.type === "Network Fee Estimate");
    if (!hasNetworkFee) {
      errors.push("Expected Network Fee not found");
    }
  }

  // Check fees length
  if (result.fees?.length !== fixture.expectedOutput.expectedFeesLength) {
    errors.push(
      `Expected ${fixture.expectedOutput.expectedFeesLength} fees, got ${result.fees?.length}`
    );
  }

  // Check allocations
  if (result.allocations?.length < fixture.expectedOutput.minAllocations) {
    errors.push(
      `Expected at least ${fixture.expectedOutput.minAllocations} allocations, got ${result.allocations?.length}`
    );
  }

  // Check all allocations positive
  const hasNegativeAllocation = result.allocations?.some((a: any) => a.amount < 0);
  if (hasNegativeAllocation) {
    errors.push("Found negative allocation");
  }

  // Check APY range
  const expectedApy = result.postDepositExposure?.expectedApy;
  if (
    expectedApy < fixture.expectedOutput.expectedApyRange.min ||
    expectedApy > fixture.expectedOutput.expectedApyRange.max
  ) {
    errors.push(
      `Expected APY in range [${fixture.expectedOutput.expectedApyRange.min}, ${fixture.expectedOutput.expectedApyRange.max}], got ${expectedApy}`
    );
  }

  // Check warnings — works with both structured SimulationWarning objects and plain strings
  const warnings: unknown[] = result.warnings || [];
  const hasCode = (code: string) =>
    warnings.some((w: unknown) =>
      typeof w === "object" && w !== null && (w as Record<string, unknown>).code === code
    );
  const hasText = (text: string) =>
    warnings.some((w: unknown) =>
      typeof w === "string" && w.toLowerCase().includes(text.toLowerCase())
    );

  if (fixture.expectedOutput.expectedWarnings.highSlippage) {
    if (!hasCode("HIGH_SLIPPAGE") && !hasText("slippage")) {
      errors.push("Expected high slippage warning");
    }
  }

  if (fixture.expectedOutput.expectedWarnings.insufficientLiquidity) {
    if (!hasCode("INSUFFICIENT_LIQUIDITY") && !hasText("liquidity")) {
      errors.push("Expected insufficient liquidity warning");
    }
  }

  if (fixture.expectedOutput.expectedWarnings.unsupported) {
    if (
      !hasCode("ZERO_AMOUNT") &&
      !hasCode("UNSUPPORTED_STRATEGY") &&
      !hasCode("AMOUNT_TOO_LARGE") &&
      !hasText("Amount") &&
      !hasText("Unsupported")
    ) {
      errors.push("Expected unsupported/amount warning");
    }
  }

  // Check routing
  if (fixture.expectedOutput.hasValidRoutingPath) {
    if (!result.routing?.path || result.routing.path.length === 0) {
      errors.push("Expected valid routing path");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
