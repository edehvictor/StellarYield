/**
 * Multi-Vault Portfolio Builder
 * Drag-slider allocation UI for distributing capital across multiple vaults
 */

import { useState, useCallback, useMemo } from "react";
import { Zap, AlertCircle, CheckCircle2 } from "lucide-react";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import type { TxPhase } from "../../services/transactionPhase";
import type { VaultAllocation, PortfolioPreset } from "./types";
import {
  calculateBlendedApy,
  isValidAllocation,
  distributeAmount,
  normalizeWeights,
  applyPreset,
} from "./portfolioUtils";
import RebalancePreview from "./RebalancePreviewPanel";
import AllocationDeltaPreview from "./AllocationDeltaPreview";
import { useWallet } from "../../context/useWallet";
import { deposit } from "../../services/soroban";

export interface PortfolioBuilderProps {
  walletAddress: string | null;
  availableVaults: Array<{ contractId: string; name: string; apy: number }>;
}

function buildInitialAllocations(
  availableVaults: PortfolioBuilderProps["availableVaults"],
): VaultAllocation[] {
  return availableVaults.slice(0, 3).map((v) => ({
    vaultContractId: v.contractId,
    vaultName: v.name,
    apy: v.apy,
    weight: 100 / Math.min(3, availableVaults.length),
    amount: 0n,
  }));
}

export default function PortfolioBuilder({
  walletAddress,
  availableVaults,
}: PortfolioBuilderProps) {
  const { signTransaction } = useWallet();
  const [totalAmount, setTotalAmount] = useState("");
  const [allocations, setAllocations] = useState<VaultAllocation[]>(() =>
    buildInitialAllocations(availableVaults),
  );
  // Baseline ("current") position the rebalance sandbox previews against.
  const [baselineAllocations] = useState<VaultAllocation[]>(() =>
    buildInitialAllocations(availableVaults),
  );
  // Last-confirmed/saved allocations — used by AllocationDeltaPreview as the
  // "before" snapshot so users can review pending changes before saving.
  const [savedAllocations, setSavedAllocations] = useState<VaultAllocation[]>(
    () => buildInitialAllocations(availableVaults),
  );
  const [isSavingAllocation, setIsSavingAllocation] = useState(false);
  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState("");
  const [executeTx, setExecuteTx] = useState(false);

  /**
   * Confirm the current draft allocations as the new saved state.
   * In a production flow this would persist to a backend; here it updates
   * the local saved snapshot so the delta preview reflects the new baseline.
   */
  const handleSaveAllocation = useCallback(async () => {
    setIsSavingAllocation(true);
    try {
      // Simulate async save (replace with real API call if needed)
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      setSavedAllocations([...allocations]);
    } finally {
      setIsSavingAllocation(false);
    }
  }, [allocations]);

  const handlePresetApply = useCallback(
    (preset: PortfolioPreset) => {
      setAllocations(applyPreset(availableVaults, preset));
    },
    [availableVaults],
  );

  const isValid = useMemo(() => isValidAllocation(allocations), [allocations]);

  const blendedApy = useMemo(
    () => calculateBlendedApy(allocations),
    [allocations],
  );

  const distributedAllocations = useMemo(() => {
    if (!totalAmount || !isValid) return allocations;
    try {
      return distributeAmount(BigInt(totalAmount), allocations);
    } catch {
      return allocations;
    }
  }, [totalAmount, allocations, isValid]);

  const handleWeightChange = useCallback(
    (index: number, newWeight: number) => {
      const updated = [...allocations];
      updated[index].weight = Math.max(0, Math.min(100, newWeight));
      setAllocations(normalizeWeights(updated));
    },
    [allocations],
  );

  const handleExecuteDeposits = useCallback(async () => {
    if (!walletAddress) {
      setError("Wallet not connected");
      return;
    }

    if (!totalAmount || !isValid) {
      setError("Invalid allocation or amount");
      return;
    }

    setError("");
    setTxPhase("building");

    try {
      if (executeTx) {
        const activeAllocations = distributedAllocations.filter(
          (a) => a.amount > 0n,
        );
        if (activeAllocations.length === 0) {
          throw new Error("No allocations to execute");
        }
        for (const alloc of activeAllocations) {
          // Deposit into each vault with 1% slippage limit
          const minShares = (alloc.amount * 99n) / 100n;
          const res = await deposit(
            walletAddress,
            alloc.amount,
            minShares,
            (phase) => setTxPhase(phase),
            true,
            signTransaction,
          );
          if (!res.success) {
            throw new Error(
              res.error || `Failed to deposit into ${alloc.vaultName}`,
            );
          }
        }
        setTxPhase("success");
      } else {
        // Mock flow
        setTxPhase("simulating");
        await new Promise((resolve) => setTimeout(resolve, 1000));

        setTxPhase("waiting_for_wallet");
        await new Promise((resolve) => setTimeout(resolve, 500));

        setTxPhase("submitting");
        await new Promise((resolve) => setTimeout(resolve, 1000));

        setTxPhase("polling");
        await new Promise((resolve) => setTimeout(resolve, 2000));

        setTxPhase("success");
      }
    } catch (err) {
      setTxPhase("failure");
      setError(err instanceof Error ? err.message : "Deposit failed");
    }
  }, [
    walletAddress,
    totalAmount,
    isValid,
    executeTx,
    distributedAllocations,
    signTransaction,
  ]);

  return (
    <div className="space-y-6">
      {/* Total Amount Input */}
      <div className="glass-panel p-6 space-y-4">
        <h2 className="text-xl font-semibold">Portfolio Allocation</h2>

        <div>
          <label className="block text-sm text-gray-400 mb-2">
            Total Amount (USDC)
          </label>
          <input
            type="number"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            placeholder="Enter amount to allocate"
            className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
          />
        </div>

        {/* Presets */}
        <div className="space-y-2">
          <label className="block text-sm text-gray-400">
            Allocation Presets
          </label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                "conservative",
                "balanced",
                "aggressive",
                "stablecoin-heavy",
              ] as PortfolioPreset[]
            ).map((p) => (
              <button
                key={p}
                onClick={() => handlePresetApply(p)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-xs font-medium rounded-md capitalize transition-colors border border-gray-700"
              >
                {p.replace("-", " ")}
              </button>
            ))}
          </div>
        </div>

        {/* Blended APY Display */}
        <div className="p-3 bg-gradient-to-r from-purple-500/10 to-blue-500/10 border border-purple-500/30 rounded-lg">
          <p className="text-sm text-gray-400">Blended APY</p>
          <p className="text-2xl font-bold text-white">
            {blendedApy.toFixed(2)}%
          </p>
        </div>
      </div>

      {/* Allocation Sliders */}
      <div className="glass-panel p-6 space-y-4">
        <h3 className="text-lg font-semibold">Vault Allocation</h3>

        {allocations.map((alloc, idx) => (
          <div key={alloc.vaultContractId} className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{alloc.vaultName}</p>
                <p className="text-xs text-gray-400">
                  {alloc.apy.toFixed(2)}% APY
                </p>
              </div>
              <div className="text-right">
                <p className="font-semibold">{alloc.weight.toFixed(1)}%</p>
                {totalAmount && (
                  <p className="text-xs text-gray-400">
                    {(BigInt(totalAmount) *
                      BigInt(Math.round(alloc.weight * 100))) /
                      BigInt(10000)}{" "}
                    USDC
                  </p>
                )}
              </div>
            </div>

            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={alloc.weight}
              onChange={(e) =>
                handleWeightChange(idx, parseFloat(e.target.value))
              }
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
          </div>
        ))}

        {!isValid && (
          <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <AlertCircle className="w-5 h-5 text-yellow-500" />
            <span className="text-sm text-yellow-400">
              Allocations must sum to 100%
            </span>
          </div>
        )}
      </div>

      {/* Summary */}
      {totalAmount && isValid && (
        <div className="glass-panel p-6 space-y-3">
          <h3 className="text-lg font-semibold">Allocation Summary</h3>
          {distributedAllocations.map((alloc) => (
            <div
              key={alloc.vaultContractId}
              className="flex justify-between text-sm"
            >
              <span className="text-gray-400">{alloc.vaultName}</span>
              <span className="font-medium">
                {alloc.amount.toString()} USDC
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Allocation Delta Preview — before/after diff shown before saving */}
      <AllocationDeltaPreview
        totalValueUsd={Number(totalAmount) || 0}
        savedAllocations={savedAllocations}
        draftAllocations={allocations}
        onConfirm={handleSaveAllocation}
        isSaving={isSavingAllocation}
      />

      {/* Rebalance Simulation Sandbox */}
      {totalAmount && Number(totalAmount) > 0 && (
        <RebalancePreview
          totalValueUsd={Number(totalAmount)}
          currentAllocations={baselineAllocations}
          targetAllocations={allocations}
          disabled={!isValid}
        />
      )}

      {/* Error Display */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertCircle className="w-5 h-5 text-red-500" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {/* Opt-in Checkbox */}
      <div className="flex items-center gap-2 px-1">
        <input
          type="checkbox"
          id="execute-tx-toggle"
          checked={executeTx}
          onChange={(e) => setExecuteTx(e.target.checked)}
          className="rounded border-gray-600 bg-black/50 text-purple-600 focus:ring-purple-500"
        />
        <label htmlFor="execute-tx-toggle" className="text-sm text-gray-300">
          Execute transaction on-chain (wallet signature required)
        </label>
      </div>

      {/* Execute Button */}
      <button
        onClick={handleExecuteDeposits}
        disabled={!isValid || !totalAmount || txPhase !== "idle"}
        className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex items-center justify-center gap-2"
      >
        <Zap className="w-5 h-5" />
        Execute Multi-Vault Deposit
      </button>

      {/* Transaction Timeline */}
      {txPhase !== "idle" && (
        <div className="glass-panel p-6">
          <TxStatusTimeline
            steps={[
              "building",
              "simulating",
              "waiting_for_wallet",
              "submitting",
              "polling",
            ]}
            phase={txPhase}
            errorMessage={error}
          />
        </div>
      )}

      {txPhase === "success" && (
        <div className="flex items-center gap-2 p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
          <CheckCircle2 className="w-5 h-5 text-green-500" />
          <span className="text-sm text-green-400">
            Deposits completed successfully!
          </span>
        </div>
      )}
    </div>
  );
}
