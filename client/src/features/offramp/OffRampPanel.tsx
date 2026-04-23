/**
 * Fiat Off-Ramp Panel
 * UI for withdrawing vault shares to bank account via off-ramp provider
 */

import { useState, useCallback, useEffect } from "react";
import {
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
} from "lucide-react";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import type { TxPhase } from "../../services/transactionPhase";
import { OffRampService } from "./offRampService";
import type { OffRampTransaction, WithdrawalRequest } from "./types";

export interface OffRampPanelProps {
  walletAddress: string | null;
  vaultContractId: string;
  vaultTokenSymbol: string;
}

export default function OffRampPanel({
  walletAddress,
  vaultContractId,
  vaultTokenSymbol,
}: OffRampPanelProps) {
  const [shares, setShares] = useState("");
  const [usdcAmount, setUsdcAmount] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const [currentTxId, setCurrentTxId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<OffRampTransaction[]>([]);
  const [error, setError] = useState("");

  const service = new OffRampService(
    "moonpay",
    import.meta.env.VITE_OFFRAMP_API_KEY || "",
    import.meta.env.VITE_OFFRAMP_BASE_URL || "https://api.moonpay.com",
  );

  // Load transaction history
  useEffect(() => {
    setTransactions(service.getAllTransactions());
  }, []);

  // Poll current transaction status
  useEffect(() => {
    if (!currentTxId || txPhase === "success" || txPhase === "failure") return;

    const interval = setInterval(async () => {
      const tx = await service.pollStatus(currentTxId);
      if (tx) {
        if (tx.status === "completed") {
          setTxPhase("success");
        } else if (tx.status === "failed") {
          setTxPhase("failure");
          setError(tx.errorMessage || "Withdrawal failed");
        }
        setTransactions(service.getAllTransactions());
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [currentTxId, txPhase]);

  const handleInitiateWithdrawal = useCallback(async () => {
    if (!walletAddress) {
      setError("Wallet not connected");
      return;
    }

    if (!shares || !usdcAmount || !bankAccount || !accountHolder) {
      setError("Please fill in all fields");
      return;
    }

    setError("");
    setTxPhase("building");

    try {
      const request: WithdrawalRequest = {
        vaultContractId,
        shares: BigInt(shares),
        usdcAmount: BigInt(usdcAmount),
        bankAccount,
        bankName,
        accountHolder,
      };

      setTxPhase("submitting");
      const tx = await service.initiateWithdrawal(request);
      setCurrentTxId(tx.id);
      setTxPhase("polling");
      setTransactions(service.getAllTransactions());
    } catch (err) {
      setTxPhase("failure");
      setError(err instanceof Error ? err.message : "Withdrawal failed");
    }
  }, [
    walletAddress,
    shares,
    usdcAmount,
    bankAccount,
    bankName,
    accountHolder,
    vaultContractId,
  ]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case "failed":
        return <XCircle className="w-5 h-5 text-red-500" />;
      case "pending":
        return <Clock className="w-5 h-5 text-yellow-500 animate-spin" />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Withdrawal Form */}
      <div className="glass-panel p-6 space-y-4">
        <h2 className="text-xl font-semibold">Withdraw to Bank Account</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Vault Shares
            </label>
            <input
              type="number"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              placeholder="0.00"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              USDC Amount
            </label>
            <input
              type="number"
              value={usdcAmount}
              onChange={(e) => setUsdcAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-2">
            Bank Account Number
          </label>
          <input
            type="text"
            value={bankAccount}
            onChange={(e) => setBankAccount(e.target.value)}
            placeholder="Enter account number"
            className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Bank Name
            </label>
            <input
              type="text"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="e.g., Chase"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Account Holder
            </label>
            <input
              type="text"
              value={accountHolder}
              onChange={(e) => setAccountHolder(e.target.value)}
              placeholder="Full name"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <AlertCircle className="w-5 h-5 text-red-500" />
            <span className="text-sm text-red-400">{error}</span>
          </div>
        )}

        <button
          onClick={handleInitiateWithdrawal}
          disabled={txPhase !== "idle"}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex items-center justify-center gap-2"
        >
          <ArrowRight className="w-5 h-5" />
          Withdraw to Bank
        </button>
      </div>

      {/* Transaction Timeline */}
      {txPhase !== "idle" && (
        <div className="glass-panel p-6">
          <TxStatusTimeline
            steps={["submitting", "polling"]}
            phase={txPhase}
            errorMessage={error}
          />
        </div>
      )}

      {/* Transaction History */}
      {transactions.length > 0 && (
        <div className="glass-panel p-6 space-y-4">
          <h3 className="text-lg font-semibold">Recent Withdrawals</h3>
          <div className="space-y-3">
            {transactions.slice(-5).map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between p-3 bg-black/30 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  {getStatusIcon(tx.status)}
                  <div>
                    <p className="text-sm font-medium">{tx.amount} USDC</p>
                    <p className="text-xs text-gray-400">
                      {new Date(tx.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <span className="text-xs font-semibold text-gray-400 capitalize">
                  {tx.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
