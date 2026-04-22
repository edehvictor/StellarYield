/**
 * Soroban Transaction Engine
 *
 * Constructs, signs via the active wallet adapter, and submits Soroban contract calls.
 * Designed to work with the YieldVault contract for deposit/withdraw.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import freighter from "@stellar/freighter-api";
import type { TxPhase } from "./transactionPhase";

// ── Configuration ───────────────────────────────────────────────────────

export const RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID ?? "";
const ZAP_CONTRACT_ID = import.meta.env.VITE_ZAP_CONTRACT_ID ?? "";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

type FeePriority = "low" | "average" | "high";

interface FeeOraclePayload {
  fees?: Partial<Record<FeePriority, number>>;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface TxResult {
  success: boolean;
  hash?: string;
  error?: string;
}

/** Lifecycle phases for Soroban flows (timeline + callbacks). */
export type { TxPhase };

/** @deprecated Prefer `TxPhase`; kept for older call sites. */
export type TxStatus = TxPhase;

export type TxPhaseCallback = (phase: TxPhase) => void;

// ── Helpers ─────────────────────────────────────────────────────────────

function getServer(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(RPC_URL);
}

async function getRecommendedBaseFee(priority: FeePriority = "average"): Promise<string> {
  try {
    const response = await fetch("/api/fees");
    if (!response.ok) {
      return StellarSdk.BASE_FEE;
    }
    const payload = (await response.json()) as FeeOraclePayload;
    const fee = payload.fees?.[priority];
    if (!fee || !Number.isFinite(fee) || fee <= 0) {
      return StellarSdk.BASE_FEE;
    }
    return String(Math.round(fee));
  } catch {
    return StellarSdk.BASE_FEE;
  }
}

function getContract(): StellarSdk.Contract {
  if (!CONTRACT_ID) {
    throw new Error("VITE_CONTRACT_ID is not configured");
  }
  return new StellarSdk.Contract(CONTRACT_ID);
}

export function getZapContract(): StellarSdk.Contract {
  if (!ZAP_CONTRACT_ID) {
    throw new Error("VITE_ZAP_CONTRACT_ID is not configured");
  }
  return new StellarSdk.Contract(ZAP_CONTRACT_ID);
}

/**
 * Build a Soroban contract call transaction, simulate it, and return
 * the assembled (ready-to-sign) XDR.
 */
async function buildContractCallOn(
  contract: StellarSdk.Contract,
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
): Promise<string> {
  onPhase?.("building");
  const server = getServer();
  const source = await server.getAccount(sourcePublicKey);
  const baseFee = await getRecommendedBaseFee("average");

  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: baseFee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  onPhase?.("simulating");
  const simulated = await server.simulateTransaction(tx);

  if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
    const errResp = simulated as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${errResp.error}`);
  }

  const assembled = StellarSdk.rpc.assembleTransaction(
    tx,
    simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse,
  ).build();

  return assembled.toXDR();
}

async function buildContractCall(
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
): Promise<string> {
  return buildContractCallOn(getContract(), sourcePublicKey, method, args, onPhase);
}

/**
 * Sign a transaction XDR with the user's Freighter wallet.
 * @deprecated Use `signTransaction` parameter in `executeContractCall` instead.
 */
async function signWithFreighter(xdr: string, networkPassphrase: string): Promise<string> {
  const signed = await freighter.signTransaction(xdr, {
    networkPassphrase,
  });
  const signedXdr = signed?.signedTxXdr;
  if (!signedXdr) throw new Error("Transaction was rejected by wallet");
  return signedXdr;
}

/**
 * Submit a signed transaction to the Soroban RPC and poll until
 * it reaches a terminal state.
 */
async function submitAndPoll(signedXdr: string, onPhase?: TxPhaseCallback): Promise<TxResult> {
  onPhase?.("submitting");
  const server = getServer();
  const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendResponse = await server.sendTransaction(tx);

  if (sendResponse.status === "ERROR") {
    return {
      success: false,
      error: `Submission rejected: ${sendResponse.errorResult?.toXDR("base64") ?? "unknown"}`,
    };
  }

  const hash = sendResponse.hash;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let result = await server.getTransaction(hash);

  onPhase?.("polling");
  while (
    result.status === StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    result = await server.getTransaction(hash);
  }

  if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
    return { success: true, hash };
  }

  if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
    return { success: false, hash, error: "Transaction failed on-chain" };
  }

  return { success: false, hash, error: "Transaction timed out" };
}

/**
 * Submit an already-signed transaction XDR (e.g. governance multisig) and poll for inclusion.
 */
export async function submitSignedXdrAndPoll(
  signedXdr: string,
  onPhase?: TxPhaseCallback,
): Promise<TxResult> {
  try {
    const result = await submitAndPoll(signedXdr, onPhase);
    onPhase?.(result.success ? "success" : "failure");
    return result;
  } catch (err) {
    onPhase?.("failure");
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Execute a full contract call: build → sign → submit → poll.
 *
 * @param sourcePublicKey  - Caller's Stellar public key
 * @param method           - Contract method name (e.g. "deposit")
 * @param args             - ScVal arguments
 * @param onPhase         - Optional callback for phase updates (timeline)
 * @param useFeeBump       - Whether to wrap the tx in a fee-bump via the relayer
 * @param signTx           - Optional signer function; defaults to Freighter for
 *                           backwards compatibility. Pass `wallet.signTransaction`
 *                           from `useWallet()` to use the active wallet adapter.
 */
export async function executeContractCall(
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = false,
  signTx?: (xdr: string, networkPassphrase: string) => Promise<string>,
): Promise<TxResult> {
  try {
    const xdr = await buildContractCall(sourcePublicKey, method, args, onPhase);

    onPhase?.("waiting_for_wallet");
    const signer = signTx ?? ((x: string, p: string) => signWithFreighter(x, p));
    const signedXdr = await signer(xdr, NETWORK_PASSPHRASE);

    let finalXdr = signedXdr;
    if (useFeeBump) {
      onPhase?.("submitting");
      const resp = await fetch("/api/relayer/fee-bump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ innerTxXdr: signedXdr }),
      });
      const { feeBumpXdr } = await resp.json();
      finalXdr = feeBumpXdr;
    }

    const result = await submitAndPoll(finalXdr, onPhase);

    onPhase?.(result.success ? "success" : "failure");
    return result;
  } catch (err) {
    onPhase?.("failure");
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Invoke a method on the Zap contract (swap + `deposit_for` in one tx).
 *
 * Uses the same build → sign → submit flow as `executeContractCall`.
 */
export async function executeZapContractCall(
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = false,
): Promise<TxResult> {
  try {
    const xdr = await buildContractCallOn(getZapContract(), sourcePublicKey, method, args, onPhase);

    onPhase?.("waiting_for_wallet");
    const signedXdr = await signWithFreighter(xdr, NETWORK_PASSPHRASE);

    let finalXdr = signedXdr;
    if (useFeeBump) {
      onPhase?.("submitting");
      const resp = await fetch("/api/relayer/fee-bump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ innerTxXdr: signedXdr }),
      });
      const { feeBumpXdr } = await resp.json();
      finalXdr = feeBumpXdr;
    }

    const result = await submitAndPoll(finalXdr, onPhase);

    onPhase?.(result.success ? "success" : "failure");
    return result;
  } catch (err) {
    onPhase?.("failure");
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ZapDepositParams {
  /** Soroban contract ID of the token the user spends (input). */
  inputTokenContract: string;
  /** Soroban contract ID of the vault’s underlying token. */
  vaultTokenContract: string;
  /** Yield vault contract ID (same family as `VITE_CONTRACT_ID`). */
  vaultContractId: string;
  amountIn: bigint;
  /** Minimum vault-token amount after swap; enforces slippage on-chain. */
  minAmountOut: bigint;
  /** Minimum shares to mint in vault deposit_for. */
  minSharesOut: bigint;
}

/**
 * Submit a single `zap_deposit` call: pull input token, swap via DEX router, deposit into vault.
 *
 * @param userAddress - Account that signs and receives vault shares
 */
export async function zapDeposit(
  userAddress: string,
  params: ZapDepositParams,
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = false,
): Promise<TxResult> {
  return executeZapContractCall(
    userAddress,
    "zap_deposit",
    [
      new StellarSdk.Address(userAddress).toScVal(),
      new StellarSdk.Address(params.inputTokenContract).toScVal(),
      new StellarSdk.Address(params.vaultTokenContract).toScVal(),
      new StellarSdk.Address(params.vaultContractId).toScVal(),
      StellarSdk.nativeToScVal(params.amountIn, { type: "i128" }),
      StellarSdk.nativeToScVal(params.minAmountOut, { type: "i128" }),
      StellarSdk.nativeToScVal(params.minSharesOut, { type: "i128" }),
    ],
    onPhase,
    useFeeBump,
  );
}

/**
 * Deposit tokens into the YieldVault contract.
 *
 * @param userAddress - Depositor's public key
 * @param amount      - Amount in stroops (1 XLM = 10_000_000 stroops)
 * @param onPhase    - Phase callback for UI updates
 * @param useFeeBump  - Whether to wrap the tx in a fee-bump via the relayer
 * @param signTx      - Optional signer; pass `wallet.signTransaction` to use any wallet adapter
 */
export async function deposit(
  userAddress: string,
  amount: bigint,
  minSharesOut: bigint,
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = true,
  signTx?: (xdr: string, networkPassphrase: string) => Promise<string>,
): Promise<TxResult> {
  return executeContractCall(
    userAddress,
    "deposit",
    [
      new StellarSdk.Address(userAddress).toScVal(),
      StellarSdk.nativeToScVal(amount, { type: "i128" }),
      StellarSdk.nativeToScVal(minSharesOut, { type: "i128" }),
    ],
    onPhase,
    useFeeBump,
    signTx,
  );
}

/**
 * Withdraw shares from the YieldVault contract.
 *
 * @param userAddress - Withdrawer's public key
 * @param shares      - Number of vault shares to redeem
 * @param onPhase    - Phase callback for UI updates
 * @param signTx      - Optional signer; pass `wallet.signTransaction` to use any wallet adapter
 */
export async function withdraw(
  userAddress: string,
  shares: bigint,
  onPhase?: TxPhaseCallback,
  signTx?: (xdr: string, networkPassphrase: string) => Promise<string>,
): Promise<TxResult> {
  return executeContractCall(
    userAddress,
    "withdraw",
    [
      new StellarSdk.Address(userAddress).toScVal(),
      StellarSdk.nativeToScVal(shares, { type: "i128" }),
    ],
    onPhase,
    false,
    signTx,
  );
}
