import { useRef, useState } from "react";
import freighter from "@stellar/freighter-api";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import { useWallet } from "../../context/useWallet";
import { submitSignedXdrAndPoll } from "../../services/soroban";
import type { TxPhase } from "../../services/transactionPhase";
import {
  TX_PHASE_SUBMIT_POLL,
  TX_PHASE_WALLET_ONLY,
} from "../../services/transactionPhase";
import type { PendingTransaction } from "./types";

const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

interface PendingTransactionCardProps {
  transaction: PendingTransaction;
  onSign: (txId: string, publicKey: string) => void;
  onExecute: (txId: string) => void;
}

export default function PendingTransactionCard({
  transaction,
  onSign,
  onExecute,
}: PendingTransactionCardProps) {
  const { walletAddress } = useWallet();
  const [signing, setSigning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [signPhase, setSignPhase] = useState<TxPhase>("idle");
  const [signError, setSignError] = useState<string | null>(null);

  const [execPhase, setExecPhase] = useState<TxPhase>("idle");
  const [execError, setExecError] = useState<string | null>(null);
  const [execHash, setExecHash] = useState<string | null>(null);
  const lastExecPhaseRef = useRef<TxPhase>("idle");

  const hasSigned = transaction.signatures.some(
    (s) => s.publicKey === walletAddress,
  );
  const isReady = transaction.signatures.length >= transaction.threshold;
  const isExecuted = transaction.status === "executed";

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
    setExecHash(null);
    lastExecPhaseRef.current = "idle";

    try {
      const result = await submitSignedXdrAndPoll(transaction.xdr, (p) => {
        setExecPhase(p);
        if (p !== "success" && p !== "failure") {
          lastExecPhaseRef.current = p;
        }
      });

      if (result.success) {
        setExecHash(result.hash ?? null);
        onExecute(transaction.id);
      } else {
        const msg = result.error ?? "Transaction failed";
        setExecError(msg);
        setError(msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExecError(msg);
      setError(msg);
    } finally {
      setExecuting(false);
    }
  }

  const retryExecute = () => {
    setExecError(null);
    setError(null);
    void handleExecute();
  };

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
                {executing ? "Executing..." : "Execute"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
