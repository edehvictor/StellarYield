import { useState } from "react";
import { ShieldCheck, Users, FileSignature } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import { useGovernanceStore } from "./useGovernanceStore";
import TransactionBuilder from "./TransactionBuilder";
import PendingTransactionCard from "./PendingTransactionCard";
import GovernanceForecast from "./GovernanceForecast";
import ProposalAttachments from "./ProposalAttachments";
import type { GovernanceConfig, PendingTransaction } from "./types";
import { RouterUpgradePanel } from "../../features/router_upgrade";
import { serializeSignerRotationAuditCsv } from "./signerRotationAudit";

export default function GovernanceDashboard() {
  const { walletAddress, isConnected } = useWallet();
  const {
    transactions,
    config,
    signerRotationAudit,
    addTransaction,
    addSignature,
    markExecuted,
    updateConfig,
  } = useGovernanceStore();

  const [showConfig, setShowConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState<GovernanceConfig>(config);
  const [configurationError, setConfigurationError] = useState("");
  const [exportError, setExportError] = useState("");
  const [exportMessage, setExportMessage] = useState("");

  const isSigner =
    walletAddress !== null && config.signers.includes(walletAddress);

  const pendingTxns = transactions.filter((t) => t.status === "pending");
  const readyTxns = transactions.filter((t) => t.status === "ready");
  const executedTxns = transactions.filter((t) => t.status === "executed");

  function handleSaveConfig() {
    setConfigurationError("");
    try {
      updateConfig(configDraft, walletAddress ?? "Unknown wallet");
      setShowConfig(false);
    } catch (error) {
      setConfigurationError(
        error instanceof Error
          ? error.message
          : "Unable to save governance configuration and signer audit.",
      );
    }
  }

  function handleExportSignerAudit() {
    setExportError("");
    setExportMessage("");
    try {
      const csv = serializeSignerRotationAuditCsv(signerRotationAudit);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "governance-signer-rotation-audit.csv";
      link.click();
      URL.revokeObjectURL(url);
      setExportMessage("Signer rotation audit CSV downloaded.");
    } catch {
      setExportError("Unable to export the signer rotation audit. Please try again.");
    }
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
          {configurationError && (
            <p role="alert" className="text-sm text-red-400">
              {configurationError}
            </p>
          )}
        </div>
      )}

      <section
        className="glass-card p-6 space-y-4"
        aria-labelledby="signer-audit-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="signer-audit-heading" className="text-lg font-bold">
              Signer Rotation Audit
            </h3>
            <p className="text-sm text-gray-400">
              {signerRotationAudit.length} configuration change
              {signerRotationAudit.length === 1 ? "" : "s"} recorded in this
              browser
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportSignerAudit}
            className="btn-secondary px-4 py-2 text-sm"
          >
            Export CSV
          </button>
        </div>
        {exportError && (
          <p role="alert" className="text-sm text-red-400">
            {exportError}
          </p>
        )}
        {exportMessage && (
          <p role="status" className="text-sm text-green-400">
            {exportMessage}
          </p>
        )}
        {signerRotationAudit.length === 0 ? (
          <p className="text-sm text-gray-500">
            No signer rotations recorded yet. The CSV export will contain its
            column headers only.
          </p>
        ) : (
          <ol className="space-y-3">
            {[...signerRotationAudit].reverse().map((record, index) => (
              <li
                key={`${record.timestamp}-${signerRotationAudit.length - index}`}
                className="border-t border-gray-700 pt-3 text-sm"
              >
                <p className="font-medium">
                  {new Date(record.timestamp).toLocaleString()} · {record.actor}
                </p>
                <p className="text-gray-400">
                  Added: {record.addedSigners.join(", ") || "None"} · Removed:{" "}
                  {record.removedSigners.join(", ") || "None"} · Threshold:{" "}
                  {record.previousThreshold} → {record.nextThreshold}
                </p>
                <p className="text-xs text-gray-500 font-mono">
                  Contract: {record.contractId || "Not configured"}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Transaction Builder */}
      {isSigner && (
        <TransactionBuilder
          threshold={config.threshold}
          contractId={config.contractId}
          onTransactionCreated={handleTransactionCreated}
        />
      )}

      {/* Router Upgrade Verification & Invocation Dry-Run */}
      {isSigner && (
        <div className="mt-6">
          <RouterUpgradePanel />
        </div>
      )}
      {/* Proposal Attachments */}
      {isSigner && <ProposalAttachments />}

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
              config={config}
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
              config={config}
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
              config={config}
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
