import type { SimulationWarning } from "../../../../shared/types/simulationWarning";

// Re-export so consumers only need to import from this service.
export type { SimulationWarning } from "../../../../shared/types/simulationWarning";

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
  warnings: SimulationWarning[];
}

export interface SimulationRequestParams {
  strategyId: string;
  amount: number;
  token: string;
}

export interface FetchSimulationOptions {
  signal?: AbortSignal;
}

/** Typed cancellation for deposit simulation fetches aborted by the caller. */
export class SimulationRequestCancelledError extends Error {
  readonly cancelled = true as const;

  constructor(message = "Simulation request was cancelled") {
    super(message);
    this.name = "SimulationRequestCancelledError";
  }
}

export function isSimulationCancellation(error: unknown): boolean {
  return (
    error instanceof SimulationRequestCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { cancelled?: boolean }).cancelled === true)
  );
}

export async function fetchDepositSimulation(
  params: SimulationRequestParams,
  options?: FetchSimulationOptions
): Promise<SimulationResult> {
  if (options?.signal?.aborted) {
    throw new SimulationRequestCancelledError();
  }

  let response: Response;
  try {
    response = await fetch("/api/simulator/deposit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      signal: options?.signal,
    });
  } catch (err) {
    if (
      options?.signal?.aborted ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      throw new SimulationRequestCancelledError();
    }
    throw err;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData as { error?: string }).error ||
        `Simulation failed: ${response.statusText}`
    );
  }

  return (await response.json()) as SimulationResult;
}
