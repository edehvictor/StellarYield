/**
 * Soroban Transaction Engine
 *
 * Constructs, signs via the active wallet adapter, and submits Soroban contract calls
 * using the official @stellaryield/sdk lifecycle state machine.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import freighter from "@stellar/freighter-api";
import {
  VaultClient,
  PreparedTransaction,
  SignedTransaction,
  SubmittedTransaction,
  CustomSigner,
  FreighterSigner,
  parseContractError,
  SubmissionTimeoutError,
  YIELD_VAULT_SPEC_HASH,
} from "@stellaryield/sdk";
import type { TxPhase } from "./transactionPhase";
import { resolveDeadlineSeconds, type TxSettings } from "../features/settings/types";
import { getContractId, validateContractRegistryEntry } from "./contractRegistry";
import { apiFetch } from "../lib/api";

// ── Configuration ───────────────────────────────────────────────────────

export const RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

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

function getVaultClient(contractId?: string): VaultClient {
  const cId = contractId || getContractId("vault");
  validateContractRegistryEntry("vault", cId);
  return new VaultClient({
    contractId: cId,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    specHash: YIELD_VAULT_SPEC_HASH,
  });
}

/** Current vault share balance for a user, for populating withdraw UI. */
export async function getUserShares(userAddress: string): Promise<bigint> {
  const vaultClient = getVaultClient();
  return vaultClient.getShares(userAddress);
}

/**
 * After a poll timeout, re-checks finality by transaction hash instead of
 * treating the timeout as a hard failure — the transaction may still land.
 * Emits the "recovering" phase while doing so.
 */
async function attemptRecovery(
  vaultClient: VaultClient,
  txHash: string,
  onPhase?: TxPhaseCallback,
): Promise<{ success: true; hash: string } | { success: false }> {
  onPhase?.("recovering");
  try {
    const recovered = vaultClient.recoverTransaction<bigint>(txHash);
    const confirmed = await recovered.wait({ timeoutMs: POLL_TIMEOUT_MS, pollIntervalMs: POLL_INTERVAL_MS });
    return { success: true, hash: confirmed.hash };
  } catch {
    return { success: false };
  }
}

async function getRecommendedBaseFee(priority: FeePriority = "average"): Promise<string> {
  try {
    const response = await apiFetch("/api/fees");
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
  const contractId = getContractId("vault");
  validateContractRegistryEntry("vault", contractId);
  return new StellarSdk.Contract(contractId);
}

export function getZapContract(): StellarSdk.Contract {
  const contractId = getContractId("zap");
  validateContractRegistryEntry("zap", contractId);
  return new StellarSdk.Contract(contractId);
}

async function buildContractCallOn(
  contract: StellarSdk.Contract,
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
  txSettings?: TxSettings,
): Promise<string> {
  onPhase?.("building");
  const server = getServer();
  const source = await server.getAccount(sourcePublicKey);
  const baseFee = await getRecommendedBaseFee("average");
  const timeoutSeconds = txSettings ? resolveDeadlineSeconds(txSettings) : 30;

  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: baseFee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(timeoutSeconds)
    .build();

  onPhase?.("simulating");
  const simulated = await server.simulateTransaction(tx);

  if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
    const errResp = simulated as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
    throw parseContractError(errResp.error);
  }

  const assembled = StellarSdk.rpc.assembleTransaction(
    tx,
    simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse,
  ).build();

  return assembled.toXDR();
}

async function signWithFreighter(xdr: string, networkPassphrase: string): Promise<string> {
  const signed = await freighter.signTransaction(xdr, {
    networkPassphrase,
  });
  const signedXdr = signed?.signedTxXdr;
  if (!signedXdr) throw new Error("Transaction was rejected by wallet");
  return signedXdr;
}

async function submitAndPoll(signedXdr: string, onPhase?: TxPhaseCallback): Promise<TxResult> {
  onPhase?.("submitting");
  const server = getServer();
  const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendResponse = await server.sendTransaction(tx);

  if (sendResponse.status === "ERROR") {
    const parsed = parseContractError(
      new Error(`Submission rejected: ${sendResponse.errorResult?.toXDR("base64") ?? "unknown"}`)
    );
    return {
      success: false,
      error: parsed.message,
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
    const parsed = parseContractError(new Error("Transaction failed on-chain"), result.resultXdr?.toXDR("base64"));
    return { success: false, hash, error: parsed.message };
  }

  return { success: false, hash, error: "Transaction timed out" };
}

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
    const parsed = parseContractError(err);
    return {
      success: false,
      error: parsed.message,
    };
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export async function executeContractCall(
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = false,
  signTx?: (xdr: string, networkPassphrase: string) => Promise<string>,
  txSettings?: TxSettings,
): Promise<TxResult> {
  try {
    const xdr = await buildContractCallOn(getContract(), sourcePublicKey, method, args, onPhase, txSettings);

    onPhase?.("waiting_for_wallet");
    const signer = signTx ?? ((x: string, p: string) => signWithFreighter(x, p));
    const signedXdr = await signer(xdr, NETWORK_PASSPHRASE);

    let finalXdr = signedXdr;
    if (useFeeBump) {
      onPhase?.("submitting");
      const resp = await apiFetch("/api/relayer/fee-bump", {
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
    const parsed = parseContractError(err);
    return {
      success: false,
      error: parsed.message,
    };
  }
}

export async function executeContractCallOn(
  contractId: string,
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = false,
  signTx?: (xdr: string, networkPassphrase: string) => Promise<string>,
  txSettings?: TxSettings,
): Promise<TxResult> {
  try {
    const contract = new StellarSdk.Contract(contractId);
    const xdr = await buildContractCallOn(contract, sourcePublicKey, method, args, onPhase, txSettings);

    onPhase?.("waiting_for_wallet");
    const signer = signTx ?? ((x: string, p: string) => signWithFreighter(x, p));
    const signedXdr = await signer(xdr, NETWORK_PASSPHRASE);

    let finalXdr = signedXdr;
    if (useFeeBump) {
      onPhase?.("submitting");
      const resp = await apiFetch("/api/relayer/fee-bump", {
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
    const parsed = parseContractError(err);
    return {
      success: false,
      error: parsed.message,
    };
  }
}

export async function executeZapContractCall(
  sourcePublicKey: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = false,
  txSettings?: TxSettings,
): Promise<TxResult> {
  try {
    const xdr = await buildContractCallOn(getZapContract(), sourcePublicKey, method, args, onPhase, txSettings);

    onPhase?.("waiting_for_wallet");
    const signedXdr = await signWithFreighter(xdr, NETWORK_PASSPHRASE);

    let finalXdr = signedXdr;
    if (useFeeBump) {
      onPhase?.("submitting");
      const resp = await apiFetch("/api/relayer/fee-bump", {
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
    const parsed = parseContractError(err);
    return {
      success: false,
      error: parsed.message,
    };
  }
}

export interface ZapDepositParams {
  inputTokenContract: string;
  vaultTokenContract: string;
  vaultContractId: string;
  amountIn: bigint;
  minAmountOut: bigint;
  minSharesOut: bigint;
}

export async function zapDeposit(
  userAddress: string,
  params: ZapDepositParams,
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = false,
  txSettings?: TxSettings,
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
    txSettings,
  );
}

/**
 * Deposit tokens into the YieldVault contract using the SDK VaultClient & lifecycle.
 */
export async function deposit(
  userAddress: string,
  amount: bigint,
  minSharesOut: bigint,
  onPhase?: TxPhaseCallback,
  useFeeBump: boolean = true,
  signTx?: (xdr: string, networkPassphrase: string) => Promise<string>,
  txSettings?: TxSettings,
): Promise<TxResult> {
  try {
    onPhase?.("simulating");
    const vaultClient = getVaultClient();
    const prepared = await vaultClient.deposit.prepare({
      from: userAddress,
      amount,
      min_shares_out: minSharesOut,
    });

    onPhase?.("waiting_for_wallet");
    const signer = new CustomSigner(
      userAddress,
      signTx || ((xdr: string, passphrase: string) => signWithFreighter(xdr, passphrase))
    );
    const signed = await prepared.sign(signer);

    let finalSignedXdr = signed.signedXdr;
    if (useFeeBump) {
      onPhase?.("submitting");
      const resp = await apiFetch("/api/relayer/fee-bump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ innerTxXdr: signed.signedXdr }),
      });
      const { feeBumpXdr } = await resp.json();
      finalSignedXdr = feeBumpXdr;
    }

    const submitted = await SignedTransaction.fromXDR(finalSignedXdr, prepared.meta).submit(RPC_URL);
    onPhase?.("polling");
    const confirmed = await submitted.wait({ timeoutMs: POLL_TIMEOUT_MS, pollIntervalMs: POLL_INTERVAL_MS });

    onPhase?.("success");
    return { success: true, hash: confirmed.hash };
  } catch (err) {
    if (err instanceof SubmissionTimeoutError) {
      const recovery = await attemptRecovery(getVaultClient(), (err as any).txHash, onPhase);
      if (recovery.success) {
        onPhase?.("success");
        return { success: true, hash: recovery.hash };
      }
    }
    onPhase?.("failure");
    const parsed = parseContractError(err);
    return {
      success: false,
      error: parsed.message,
    };
  }
}

/**
 * Withdraw shares from the YieldVault contract using the SDK VaultClient & lifecycle. using the SDK VaultClient & lifecycle.
 */
export async function withdraw(
  userAddress: string,
  shares: bigint,
  onPhase?: TxPhaseCallback,
  signTx?: (xdr: string, networkPassphrase: string) => Promise<string>,
  txSettings?: TxSettings,
): Promise<TxResult> {
  try {
    onPhase?.("simulating");
    const vaultClient = getVaultClient();
    const prepared = await vaultClient.withdraw.prepare({
      to: userAddress,
      shares,
    });

    onPhase?.("waiting_for_wallet");
    const signer = new CustomSigner(
      userAddress,
      signTx || ((xdr: string, passphrase: string) => signWithFreighter(xdr, passphrase))
    );
    const signed = await prepared.sign(signer);

    const submitted = await signed.submit(RPC_URL);
    onPhase?.("polling");
    const confirmed = await submitted.wait({ timeoutMs: POLL_TIMEOUT_MS, pollIntervalMs: POLL_INTERVAL_MS });

    onPhase?.("success");
    return { success: true, hash: confirmed.hash };
  } catch (err) {
    if (err instanceof SubmissionTimeoutError) {
      const recovery = await attemptRecovery(getVaultClient(), (err as any).txHash, onPhase);
      if (recovery.success) {
        onPhase?.("success");
        return { success: true, hash: recovery.hash };
      }
    }
    onPhase?.("failure");
    const parsed = parseContractError(err);
    return {
      success: false,
      error: parsed.message,
    };
  }
}
