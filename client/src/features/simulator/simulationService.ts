import type { SimulationResult } from "../../../../../server/src/services/simulationService";

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
