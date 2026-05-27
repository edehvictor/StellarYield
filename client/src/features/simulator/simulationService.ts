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

export interface SimulationRequestParams {
  strategyId: string;
  amount: number;
  token: string;
}

export async function fetchDepositSimulation(
  params: SimulationRequestParams
): Promise<SimulationResult> {
  const response = await fetch("/api/simulator/deposit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Simulation failed: ${response.statusText}`);
  }

  return (await response.json()) as SimulationResult;
}
