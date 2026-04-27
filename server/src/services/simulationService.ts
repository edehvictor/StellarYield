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
  const { amount, strategyId, token } = params;

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
