/**
 * Shared read-only Soroban contract simulation helper.
 * Extracted from the swap-specific simulation logic in zapQuote.ts so other
 * services can simulate arbitrary view calls without duplicating the
 * rpc.Server/TransactionBuilder/simulateTransaction plumbing.
 */
import * as StellarSdk from "@stellar/stellar-sdk";

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

export type ReadOnlyCallOutcome<T> =
  | { ok: true; value: T }
  /** Contract call reached the network but the contract itself returned Err(...) or panicked. */
  | { ok: false; reason: "contract_error"; message?: string }
  /** RPC/network/config unavailable — never distinguishable from a contract_error by callers that don't need to. */
  | { ok: false; reason: "unreachable" };

/**
 * Simulates a read-only call to `method` on `contractId` and returns its
 * native-decoded result. Never throws — any RPC, timeout, or contract-level
 * failure resolves to an `{ok:false}` outcome so callers can build safe
 * fallback states instead of propagating errors.
 */
export async function simulateReadOnlyCall<T>(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = [],
  opts?: { timeoutMs?: number },
): Promise<ReadOnlyCallOutcome<T>> {
  const simSource = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  if (!simSource) {
    return { ok: false, reason: "unreachable" };
  }

  try {
    const server = new StellarSdk.rpc.Server(rpcUrl);
    const contract = new StellarSdk.Contract(contractId);
    const op = contract.call(method, ...args);

    const source = await server.getAccount(simSource);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase:
        process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const timeoutMs = opts?.timeoutMs ?? parseInt(process.env.SOROBAN_RPC_TIMEOUT_MS ?? "10000", 10);
    const simulated = await Promise.race([
      server.simulateTransaction(tx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs)
      ),
    ]);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      const errorResponse = simulated as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
      return { ok: false, reason: "contract_error", message: errorResponse.error };
    }

    const success = simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    const retval = success.result?.retval;
    if (!retval) {
      return { ok: false, reason: "unreachable" };
    }

    return { ok: true, value: StellarSdk.scValToNative(retval) as T };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

export function addressArg(address: string): StellarSdk.xdr.ScVal {
  return new StellarSdk.Address(address).toScVal();
}
