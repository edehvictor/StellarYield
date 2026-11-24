/**
 * Network and ledger guard for strategy-comparison reads and writes (#1924).
 *
 * Every operation is executed against a freshly observed Stellar context.
 * Reads may be replayed when the ledger changes during the request; writes are
 * pinned to the context that produced the visible comparison data and fail
 * closed if that context has become stale.
 */

import { rpc } from "@stellar/stellar-sdk";
import {
  runWithSimulationContext,
  YIELD_VAULT_SPEC_HASH,
  type SimulationContext,
  type SimulationContextInput,
  type SimulationContextPolicy,
} from "@stellaryield/sdk";
import { getContractId } from "../../services/contractRegistry";
import {
  detectNetworkFromPassphrase,
  getNetworkPassphrase,
  getRpcUrl,
} from "../../lib/networkEnv";

const MAX_COMPARISON_LEDGER_DRIFT = 20;
const MAX_COMPARISON_CONTEXT_ATTEMPTS = 3;

export interface StrategyComparisonContextOptions<TState = unknown> {
  expected?: SimulationContextInput | SimulationContext;
  stateSnapshot?: TState;
  onTransition?: SimulationContextPolicy;
}

export async function runWithStrategyComparisonContext<TResult, TState = unknown>(
  run: (context: SimulationContext) => TResult | Promise<TResult>,
  options: StrategyComparisonContextOptions<TState> = {},
) {
  return runWithSimulationContext<TResult, TState>({
    readContext: async () => {
      const networkPassphrase = getNetworkPassphrase();
      const network = detectNetworkFromPassphrase(networkPassphrase);
      const server = new rpc.Server(getRpcUrl());
      const latestLedger = await server.getLatestLedger();

      return {
        network,
        networkPassphrase,
        contractId: getContractId("vault", network),
        contractVersion: YIELD_VAULT_SPEC_HASH,
        ledger: latestLedger.sequence,
      } satisfies SimulationContextInput;
    },
    expected: options.expected,
    stateSnapshot: options.stateSnapshot,
    maxLedgerDrift: MAX_COMPARISON_LEDGER_DRIFT,
    onTransition: options.onTransition ?? "reject",
    maxAttempts: MAX_COMPARISON_CONTEXT_ATTEMPTS,
    run,
  });
}
