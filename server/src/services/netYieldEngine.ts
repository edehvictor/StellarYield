export interface NetYieldAssumptions {
  protocolFeeBps: number;
  vaultFeeBps: number;
  rebalanceCostBps: number;
  slippageBps: number;
}

export interface YieldSensitivityProfile {
  environment: "low" | "medium" | "high";
  assumptions: NetYieldAssumptions;
  netApy: number;
  feeDragApy: number;
}

export interface NetYieldResult {
  grossApy: number;
  netApy: number;
  feeDragApy: number;
  assumptions: NetYieldAssumptions;
  sensitivity: YieldSensitivityProfile[];
  feeAttribution: FeeAttributionBreakdown;
}

export interface FeeAttributionBreakdown {
  managementFeeApy: number;
  protocolFeeApy: number;
  slippageApy: number;
  networkFeeApy: number;
  rewardOffsetApy: number;
  unknownFeeApy: number;
  totalFeeDragApy: number;
}

const BPS_DENOMINATOR = 10_000;

const DEFAULT_MEDIUM_ASSUMPTIONS: NetYieldAssumptions = {
  protocolFeeBps: 45,
  vaultFeeBps: 80,
  rebalanceCostBps: 25,
  slippageBps: 30,
};

const SENSITIVITY_ENVIRONMENTS: Record<
  YieldSensitivityProfile["environment"],
  NetYieldAssumptions
> = {
  low: {
    protocolFeeBps: 20,
    vaultFeeBps: 35,
    rebalanceCostBps: 10,
    slippageBps: 10,
  },
  medium: DEFAULT_MEDIUM_ASSUMPTIONS,
  high: {
    protocolFeeBps: 85,
    vaultFeeBps: 140,
    rebalanceCostBps: 60,
    slippageBps: 80,
  },
};

function clampBps(value: number, min = 0, max = 3_000): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function calculateFeeAttribution(
  grossApy: number,
  assumptions: NetYieldAssumptions,
): FeeAttributionBreakdown {
  const protocolFeeApy = (grossApy * assumptions.protocolFeeBps) / BPS_DENOMINATOR;
  const managementFeeApy = (grossApy * assumptions.vaultFeeBps) / BPS_DENOMINATOR;
  const networkFeeApy = (grossApy * assumptions.rebalanceCostBps) / BPS_DENOMINATOR;
  const slippageApy = (grossApy * assumptions.slippageBps) / BPS_DENOMINATOR;
  const rewardOffsetApy = Math.max(0, roundTo(grossApy * 0.0015));
  const knownFeeTotal = protocolFeeApy + managementFeeApy + networkFeeApy + slippageApy;
  const totalFeeDragApy = knownFeeTotal;
  const unknownFeeApy = Math.max(0, roundTo(totalFeeDragApy - knownFeeTotal));

  return {
    managementFeeApy: roundTo(managementFeeApy),
    protocolFeeApy: roundTo(protocolFeeApy),
    slippageApy: roundTo(slippageApy),
    networkFeeApy: roundTo(networkFeeApy),
    rewardOffsetApy,
    unknownFeeApy,
    totalFeeDragApy: roundTo(totalFeeDragApy),
  };
}

export function sanitizeAssumptions(
  assumptions?: Partial<NetYieldAssumptions>,
): NetYieldAssumptions {
  const merged = {
    ...DEFAULT_MEDIUM_ASSUMPTIONS,
    ...assumptions,
  };

  return {
    protocolFeeBps: clampBps(merged.protocolFeeBps),
    vaultFeeBps: clampBps(merged.vaultFeeBps),
    rebalanceCostBps: clampBps(merged.rebalanceCostBps),
    slippageBps: clampBps(merged.slippageBps),
  };
}

export function calculateNetYield(
  grossApy: number,
  assumptions?: Partial<NetYieldAssumptions>,
): NetYieldResult {
  const boundedGrossApy = Number.isFinite(grossApy)
    ? Math.max(-100, Math.min(1_000, grossApy))
    : 0;
  const sanitized = sanitizeAssumptions(assumptions);
  const totalBps =
    sanitized.protocolFeeBps +
    sanitized.vaultFeeBps +
    sanitized.rebalanceCostBps +
    sanitized.slippageBps;

  const feeDragApy = (boundedGrossApy * totalBps) / BPS_DENOMINATOR;
  const netApy = boundedGrossApy - feeDragApy;

  const sensitivity = (Object.keys(SENSITIVITY_ENVIRONMENTS) as Array<
    keyof typeof SENSITIVITY_ENVIRONMENTS
  >).map((environment) => {
    const envAssumptions = sanitizeAssumptions(SENSITIVITY_ENVIRONMENTS[environment]);
    const envTotalBps =
      envAssumptions.protocolFeeBps +
      envAssumptions.vaultFeeBps +
      envAssumptions.rebalanceCostBps +
      envAssumptions.slippageBps;
    const envFeeDragApy = (boundedGrossApy * envTotalBps) / BPS_DENOMINATOR;

    return {
      environment,
      assumptions: envAssumptions,
      netApy: roundTo(boundedGrossApy - envFeeDragApy),
      feeDragApy: roundTo(envFeeDragApy),
    };
  });

  return {
    grossApy: roundTo(boundedGrossApy),
    netApy: roundTo(netApy),
    feeDragApy: roundTo(feeDragApy),
    assumptions: sanitized,
    sensitivity,
    feeAttribution: calculateFeeAttribution(boundedGrossApy, sanitized),
  };
}
