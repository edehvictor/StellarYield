import { useState } from "react";
import { ShieldCheck, Users, FileSignature } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import { useGovernanceStore } from "./useGovernanceStore";
import TransactionBuilder from "./TransactionBuilder";
import PendingTransactionCard from "./PendingTransactionCard";
import GovernanceForecast from "./GovernanceForecast";
import type { GovernanceConfig, PendingTransaction } from "./types";

export default function GovernanceDashboard() {
  const { walletAddress, isConnected } = useWallet();
  const {
    transactions,
    config,
    addTransaction,
    addSignature,
    markExecuted,
    updateConfig,
  } = useGovernanceStore();

  const [showConfig, setShowConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState<GovernanceConfig>(config);

  const isSigner =
    walletAddress !== null && config.signers.includes(walletAddress);

  const pendingTxns = transactions.filter((t) => t.status === "pending");
  const readyTxns = transactions.filter((t) => t.status === "ready");
  const executedTxns = transactions.filter((t) => t.status === "executed");

  function handleSaveConfig() {
    updateConfig(configDraft);
    setShowConfig(false);
  }

  function handleTransactionCreated(tx: PendingTransaction) {
    addTransaction(tx);
  }

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <ShieldCheck size={48} className="text-indigo-400 mb-4" />
        <h2 className="text-2xl font-bold mb-2">Multi-Sig Governance</h2>
        <p className="text-gray-400">
          Connect your Freighter wallet to access the governance dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight">
            Governance
          </h2>
          <p className="text-gray-400 mt-1">
            Multi-signature admin operations for the YieldVault
          </p>
        </div>
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="btn-secondary px-4 py-2 text-sm flex items-center gap-2"
        >
          <Users size={16} /> Configure Signers
        </button>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card border-l-4 border-indigo-500 p-5">
          <p className="text-sm text-gray-400">Signers</p>
          <p className="text-2xl font-bold mt-1">{config.signers.length}</p>
        </div>
        <div className="glass-card border-l-4 border-yellow-500 p-5">
          <p className="text-sm text-gray-400">Threshold</p>
          <p className="text-2xl font-bold mt-1">
            {config.threshold} of {config.signers.length}
          </p>
        </div>
        <div className="glass-card border-l-4 border-green-500 p-5">
          <p className="text-sm text-gray-400">Pending Proposals</p>
          <p className="text-2xl font-bold mt-1">
            {pendingTxns.length + readyTxns.length}
          </p>
        </div>
      </div>

      {/* Config Panel */}
      {showConfig && (
        <div className="glass-card p-6 space-y-4">
          <h3 className="text-lg font-bold">Signer Configuration</h3>
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Signer Addresses (one per line)
            </label>
            <textarea
              value={configDraft.signers.join("\n")}
              onChange={(e) =>
                setConfigDraft((prev) => ({
                  ...prev,
                  signers: e.target.value.split("\n").filter((s) => s.trim()),
                }))
              }
              rows={5}
              className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-4 py-2 text-white font-mono text-sm"
              placeholder="GABC...&#10;GDEF...&#10;GHIJ..."
            />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-1">
                Threshold
              </label>
              <input
                type="number"
                min={1}
                max={configDraft.signers.length}
                value={configDraft.threshold}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    threshold: parseInt(e.target.value) || 1,
                  }))
                }
                className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-4 py-2 text-white"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-1">
                Contract ID
              </label>
              <input
                type="text"
                value={configDraft.contractId}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    contractId: e.target.value,
                  }))
                }
                className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-4 py-2 text-white font-mono text-sm"
              />
            </div>
          </div>
          <button
            onClick={handleSaveConfig}
            className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold px-6 py-2 rounded-lg"
          >
            Save Configuration
          </button>
        </div>
      )}

      {/* Transaction Builder */}
      {isSigner && (
        <TransactionBuilder
          threshold={config.threshold}
          contractId={config.contractId}
          onTransactionCreated={handleTransactionCreated}
        />
      )}

      {!isSigner && walletAddress && (
        <div className="glass-card p-5 text-center text-gray-400">
          <FileSignature size={24} className="mx-auto mb-2 text-gray-500" />
          <p>
            Your address is not in the signer list. Configure signers above to
            enable proposal creation.
          </p>
        </div>
      )}

      {/* Ready to Execute */}
      {readyTxns.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-yellow-400">
            Ready to Execute
          </h3>
          {readyTxns.map((tx) => (
            <PendingTransactionCard
              key={tx.id}
              transaction={tx}
              onSign={addSignature}
              onExecute={markExecuted}
            />
          ))}
        </div>
      )}

      {/* Pending Signatures */}
      {pendingTxns.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold">Awaiting Signatures</h3>
          {pendingTxns.map((tx) => (
            <PendingTransactionCard
              key={tx.id}
              transaction={tx}
              onSign={addSignature}
              onExecute={markExecuted}
            />
          ))}
        </div>
      )}

      {/* Executed */}
      {executedTxns.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-green-400">
            Executed Transactions
          </h3>
          {executedTxns.slice(0, 10).map((tx) => (
            <PendingTransactionCard
              key={tx.id}
              transaction={tx}
              onSign={addSignature}
              onExecute={markExecuted}
            />
          ))}
        </div>
      )}

      {transactions.length === 0 && (
        <div className="glass-card p-12 text-center text-gray-500">
          <p>No governance proposals yet. Use the builder above to create one.</p>
        </div>
      )}

      {/* Impact Forecast Engine */}
      <div className="mt-4">
        <GovernanceForecast />
      </div>
    </div>
  );
}
