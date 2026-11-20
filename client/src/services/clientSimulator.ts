/**
 * Client-side simulator for deposit calculations.
 * This implementation mirrors the server-side logic to ensure consistency.
 *
 * All calculations must produce identical results to the server simulator.
 */

interface ProtocolDef {
  protocolName: string;
  protocolType: string;
  baseApyBps: number;
}
const PROTOCOLS: ProtocolDef[] = [
  { protocolName: "Blend", protocolType: "blend", baseApyBps: 500 },
  { protocolName: "Soroswap", protocolType: "amm", baseApyBps: 300 },
  { protocolName: "DeFindex", protocolType: "index", baseApyBps: 400 },
];
const MAX_SAFE_SIMULATION_AMOUNT = Number.MAX_SAFE_INTEGER;

function roundTokenAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e7) / 1e7;
}
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
  netAmount: number;
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

/**
 * Simulates a deposit across strategies.
 *
 * This function implements the exact same logic as the server simulator
 * to ensure client and server remain in sync.
 *
 * @param params - The simulation parameters
 * @returns The simulation result
 */
export function simulateDeposit(params: SimulationParams): SimulationResult {
  const { amount, strategyId, token } = params;

  // We explicitly mark this as simulation-only
  const result: SimulationResult = {
    isSimulationOnly: true,
    netAmount: 0,
    allocations: [],
    expectedShares: 0,
    fees: [],
    postDepositExposure: { expectedApy: 0 },
    routing: { path: [], expectedOutput: 0 },
    warnings: [],
  };

  if (!Number.isFinite(amount) || amount <= 0) {
    result.warnings.push("Amount must be greater than zero.");
    return result;
  }
  if (amount > MAX_SAFE_SIMULATION_AMOUNT) {
    result.warnings.push("Amount is too large to calculate safely.");
    return result;
  }

  // Fees - MUST MATCH SERVER
  // Base deposit fee (e.g. 0.1%)
  const entryFee = roundTokenAmount(amount * 0.001);
  result.fees.push({ type: "Entry Fee", amount: entryFee });

  // Gas estimate - MUST MATCH SERVER
  const networkFee = 0.05; // 0.05 units of token/XLM
  result.fees.push({ type: "Network Fee Estimate", amount: networkFee });

  const netAmount = roundTokenAmount(amount - entryFee);
  result.netAmount = netAmount;

  // Illiquidity / Slippage warnings - MUST MATCH SERVER
  if (amount > 100000) {
    result.warnings.push("High slippage expected for deposits over 100k.");
  }

  if (amount > 1000000) {
    result.warnings.push("Insufficient liquidity to route this deposit fully.");
  }

  // Protocol selection - MUST MATCH SERVER
  let targetProtocols = PROTOCOLS.filter((p) => p.protocolType === "blend");
  let baseApySum = targetProtocols.reduce((acc, p) => acc + p.baseApyBps, 0);

  if (strategyId.toLowerCase().includes("aggressive")) {
    targetProtocols = PROTOCOLS.filter((p) => p.protocolType !== "blend");
    baseApySum =
      targetProtocols.reduce((acc, p) => acc + p.baseApyBps, 0) || 1000;
  }

  if (targetProtocols.length === 0) {
    result.warnings.push("Unsupported strategy or asset combination.");
    targetProtocols = [PROTOCOLS[0]]; // fallback
    baseApySum = targetProtocols[0].baseApyBps;
  }

  // Allocate proportionally based on APY (must match server exactly)
  let allocated = 0;
  let blendedApyBps = 0;

  targetProtocols.forEach((p, index) => {
    let allocAmount = 0;
    if (index === targetProtocols.length - 1) {
      allocAmount = roundTokenAmount(netAmount - allocated);
    } else {
      allocAmount = roundTokenAmount(netAmount * (p.baseApyBps / baseApySum));
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

  // Slippage calculation - must match server exactly
  const slippageLoss = roundTokenAmount(
    amount > 100000 ? netAmount * 0.01 : netAmount * 0.001,
  );
  result.expectedShares = roundTokenAmount(netAmount - slippageLoss);
  result.routing.expectedOutput = result.expectedShares;

  return result;
}

/**
 * Validates that the client simulator result matches expected characteristics.
 * This is useful for regression testing during client-side testing.
 */
export function validateSimulatorResult(result: SimulationResult): {
  valid: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Ensure it's marked as simulation-only
  if (!result.isSimulationOnly) {
    warnings.push("Result not marked as simulation-only");
  }

  // Ensure expected shares is less than the allocated net amount (due to slippage).
  const allocatedAmount = result.allocations.reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
  if (
    !Number.isFinite(allocatedAmount) ||
    !Number.isFinite(result.expectedShares) ||
    result.expectedShares < 0 ||
    result.expectedShares >= allocatedAmount
  ) {
    warnings.push(
      "Expected shares should be less than net amount due to slippage",
    );
  }

  // Ensure allocations sum to approximately net amount
  if (Math.abs(allocatedAmount - result.netAmount) > 0.0000001) {
    warnings.push("Allocations do not sum correctly");
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}
