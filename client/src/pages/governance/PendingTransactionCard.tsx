import { useRef, useState } from "react";
import freighter from "@stellar/freighter-api";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import { useWallet } from "../../context/useWallet";
import {
  resumeSubmittedTransaction,
  submitSignedXdrAndPoll,
} from "../../services/soroban";
import type { TxPhase } from "../../services/transactionPhase";
import {
  TX_PHASE_SUBMIT_POLL,
  TX_PHASE_WALLET_ONLY,
} from "../../services/transactionPhase";
import type { PendingTransaction } from "./types";
import type { GovernanceConfig } from "./types";
import SignerQuorumProgress from "./SignerQuorumProgress";
import { computeSignerQuorumProgress } from "./signerQuorum";
import { getNetworkPassphrase } from "../../lib/networkEnv";

const NETWORK_PASSPHRASE = getNetworkPassphrase();

interface PendingTransactionCardProps {
  transaction: PendingTransaction;
  onSign: (txId: string, publicKey: string) => void;
  onBeginExecute: (txId: string) => GovernanceExecutionState | null;
  onExecutionSubmitted: (txId: string, txHash: string) => void;
  onExecutionFailed: (txId: string, error: string, failedAtPhase: TxPhase) => void;
  onExecutionRolledBack?: (txId: string) => void;
  onExecute: (txId: string, txHash?: string) => void;
  /** Governance config used to render per-signer quorum progress (#1310). */
  config?: Pick<GovernanceConfig, "signers">;
}

export default function PendingTransactionCard({
  transaction,
  onSign,
  onBeginExecute,
  onExecutionSubmitted,
  onExecutionFailed,
  onExecutionRolledBack,
  onExecute,
  config,
}: PendingTransactionCardProps) {
  const { walletAddress } = useWallet();
  const [signing, setSigning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [signPhase, setSignPhase] = useState<TxPhase>("idle");
  const [signError, setSignError] = useState<string | null>(null);

  const persistedOperation = transaction.operation;
  const [execPhase, setExecPhase] = useState<TxPhase>(() =>
    executionPhaseFor(persistedOperation),
  );
  const [execError, setExecError] = useState<string | null>(() =>
    persistedOperation?.status === "failed"
      ? persistedOperation.error ?? "Execution failed"
      : null,
  );
  const [execHash, setExecHash] = useState<string | null>(
    () => persistedOperation?.txHash ?? null,
  );
  const lastExecPhaseRef = useRef<TxPhase>(
    persistedOperation?.failedAtPhase ??
      (persistedOperation?.txHash ? "polling" : "submitting"),
  );

  const hasSigned = transaction.signatures.some(
    (s) => s.publicKey === walletAddress,
  );
  const isReady = transaction.signatures.length >= transaction.threshold;
  const isExecuted = transaction.status === "executed";
  const quorumProgress = computeSignerQuorumProgress(transaction, {
    signers: config?.signers ?? [],
  });

  async function handleSign() {
    if (!walletAddress) return;
    setSigning(true);
    setError(null);
    setSignError(null);
    setSignPhase("waiting_for_wallet");

    try {
      const signed = await freighter.signTransaction(transaction.xdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      if (!signed?.signedTxXdr) {
        throw new Error("Signing was rejected by wallet");
      }

      onSign(transaction.id, walletAddress);
      setSignPhase("success");
      setTimeout(() => setSignPhase("idle"), 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setSignError(msg);
      setSignPhase("failure");
    } finally {
      setSigning(false);
    }
  }

  async function handleExecute() {
    if (!isReady) return;
    setExecuting(true);
    setError(null);
    setExecError(null);
    lastExecPhaseRef.current = "idle";

    let operation: GovernanceExecutionState | null;
    try {
      operation = onBeginExecute(transaction.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExecError(msg);
      setError(msg);
      setExecPhase("failure");
      setExecuting(false);
      return;
    }
    if (!operation) {
      setExecuting(false);
      return;
    }

    setExecPhase(executionPhaseFor(operation));
    setExecHash(operation.txHash ?? null);
    lastExecPhaseRef.current = operation.txHash ? "polling" : "submitting";

    const recordPhase = (p: TxPhase) => {
      setExecPhase(p);
      if (p !== "success" && p !== "failure") {
        lastExecPhaseRef.current = p;
      }
    };

    try {
      const result = operation.txHash
        ? await resumeSubmittedTransaction(operation.txHash, recordPhase)
        : await submitSignedXdrAndPoll(transaction.xdr, recordPhase, (hash) => {
            setExecHash(hash);
            try {
              onExecutionSubmitted(transaction.id, hash);
            } catch {
              setExecError(
                "Transaction was submitted, but its hash could not be saved. Check the network before retrying.",
              );
            }
          });

      if (result.success) {
        setExecHash(result.hash ?? operation.txHash ?? null);
        onExecute(transaction.id, result.hash);
      } else {
        const msg = result.error ?? "Transaction failed";
        const failedAtPhase = lastExecPhaseRef.current === "idle"
          ? "submitting"
          : lastExecPhaseRef.current;
        setExecError(msg);
        setError(msg);
        onExecutionFailed(transaction.id, msg, failedAtPhase);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failedAtPhase = lastExecPhaseRef.current === "idle"
        ? "submitting"
        : lastExecPhaseRef.current;
      setExecError(msg);
      setError(msg);
      onExecutionFailed(transaction.id, msg, failedAtPhase);
    } finally {
      setExecuting(false);
    }
  }

  const retryExecute = () => {
    setExecError(null);
    setError(null);
    void handleExecute();
  };

  const rollbackExecute = () => {
    if (!onExecutionRolledBack) return;
    onExecutionRolledBack(transaction.id);
    setExecError(null);
    setError(null);
    setExecHash(null);
    setExecPhase("idle");
    lastExecPhaseRef.current = "idle";
  };

  const canResumeExecution = Boolean(transaction.operation?.txHash);

  const retrySign = () => {
    setSignError(null);
    setError(null);
    void handleSign();
  };

  const statusColor = isExecuted
    ? "text-green-400"
    : isReady
      ? "text-yellow-400"
      : "text-gray-400";

  const statusLabel = isExecuted
    ? "Executed"
    : isReady
      ? "Ready to Execute"
      : `${transaction.signatures.length}/${transaction.threshold} signatures`;

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-white">{transaction.description}</p>
          <p className="text-xs text-gray-500 mt-1">
            Method: {transaction.method} | Created:{" "}
            {new Date(transaction.createdAt).toLocaleString()}
          </p>
        </div>
        <span className={`text-sm font-medium ${statusColor}`}>
          {statusLabel}
        </span>
      </div>

      <SignerQuorumProgress progress={quorumProgress} />

      <div className="flex flex-wrap gap-2">
        {transaction.signatures.map((sig) => (
          <span
            key={sig.publicKey}
            className="text-xs bg-indigo-500/20 text-indigo-300 px-2 py-1 rounded"
          >
            {sig.publicKey.slice(0, 8)}...{sig.publicKey.slice(-4)}
          </span>
        ))}
      </div>

      <div className="bg-[#1a1a2e] rounded p-3 overflow-x-auto">
        <p className="text-xs text-gray-500 mb-1">Transaction XDR</p>
        <p className="text-xs text-gray-300 font-mono break-all">
          {transaction.xdr.slice(0, 120)}...
        </p>
      </div>

      {error && signPhase !== "failure" && execPhase !== "failure" && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {!isExecuted && isExecutionInterrupted(transaction.operation) && !executing && (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200"
        >
          Execution was interrupted.{" "}
          {canResumeExecution
            ? "Retry resumes polling the saved transaction hash; the transaction is not submitted again."
            : "Retry starts a new attempt; existing signatures and the proposal are preserved."}
        </p>
      )}

      {!isExecuted && (
        <div className="flex flex-col gap-4">
          {!hasSigned && (
            <div className="space-y-2">
              <TxStatusTimeline
                steps={TX_PHASE_WALLET_ONLY}
                phase={signPhase}
                errorMessage={signPhase === "failure" ? signError : null}
                onRetry={signPhase === "failure" ? retrySign : undefined}
              />
              <button
                type="button"
                onClick={() => void handleSign()}
                disabled={signing || !walletAddress}
                className="w-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold py-2 rounded-lg hover:bg-indigo-500/30 disabled:opacity-50 transition-all"
              >
                {signing ? "Signing..." : "Sign Transaction"}
              </button>
            </div>
          )}
          {isReady && (
            <div className="space-y-2">
              <TxStatusTimeline
                steps={TX_PHASE_SUBMIT_POLL}
                phase={execPhase}
                errorMessage={execPhase === "failure" ? execError : null}
                txHash={execHash}
                failedAtPhase={
                  execPhase === "failure"
                    ? lastExecPhaseRef.current !== "idle"
                      ? lastExecPhaseRef.current
                      : "polling"
                    : null
                }
                onRetry={execPhase === "failure" ? retryExecute : undefined}
              />
              <button
                type="button"
                onClick={() => void handleExecute()}
                disabled={executing}
                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold py-2 rounded-lg disabled:opacity-50 transition-opacity"
              >
                {executing
                  ? "Executing..."
                  : canResumeExecution
                    ? "Resume Execution"
                    : "Execute"}
              </button>
              {execPhase === "failure" &&
                canRollbackExecution(transaction.operation) &&
                onExecutionRolledBack && (
                  <button
                    type="button"
                    onClick={rollbackExecute}
                    className="w-full border border-gray-600 text-gray-300 font-semibold py-2 rounded-lg hover:bg-white/5 transition-colors"
                  >
                    Discard Failed Attempt
                  </button>
                )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
