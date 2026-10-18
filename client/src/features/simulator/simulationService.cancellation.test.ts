import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchDepositSimulation,
  isSimulationCancellation,
  SimulationRequestCancelledError,
} from "./simulationService";

describe("fetchDepositSimulation cancellation (#1047)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws SimulationRequestCancelledError when aborted mid-flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true }
          );
        });
      })
    );

    const controller = new AbortController();
    const promise = fetchDepositSimulation(
      { strategyId: "s1", amount: 50, token: "USDC" },
      { signal: controller.signal }
    );
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(SimulationRequestCancelledError);
    expect(isSimulationCancellation(await promise.catch((e) => e))).toBe(true);
  });

  it("does not apply stale result after rapid amount changes abort prior request", async () => {
    const controllers: AbortController[] = [];
    let resolveFirst: ((value: Response) => void) | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true }
          );
          if (!resolveFirst) {
            resolveFirst = resolve;
          } else {
            resolve(
              new Response(
                JSON.stringify({
                  isSimulationOnly: true,
                  allocations: [],
                  expectedShares: 2,
                  fees: [],
                  postDepositExposure: { expectedApy: 0.1 },
                  routing: { path: [], expectedOutput: 2 },
                  warnings: [],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              )
            );
          }
        });
      })
    );

    const firstController = new AbortController();
    controllers.push(firstController);
    const first = fetchDepositSimulation(
      { strategyId: "s1", amount: 1, token: "USDC" },
      { signal: firstController.signal }
    );

    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(SimulationRequestCancelledError);

    const secondController = new AbortController();
    const second = await fetchDepositSimulation(
      { strategyId: "s1", amount: 2, token: "USDC" },
      { signal: secondController.signal }
    );
    expect(second.expectedShares).toBe(2);

    // Late resolve of the first request must not succeed after abort.
    resolveFirst?.(
      new Response(
        JSON.stringify({
          isSimulationOnly: true,
          allocations: [],
          expectedShares: 999,
          fees: [],
          postDepositExposure: { expectedApy: 0.9 },
          routing: { path: [], expectedOutput: 999 },
          warnings: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  });
});
