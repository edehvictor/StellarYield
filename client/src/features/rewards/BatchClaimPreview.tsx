import { useState, useEffect, useCallback } from "react";
import { AlertCircle, CheckCircle2, Clock, Zap, RefreshCw } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import { getApiBaseUrl } from "../../lib/api";
import type { BatchClaimPreview, ClaimProofData } from "./types";
import {
  buildBatchClaimPreview,
  formatYieldAmount,
  getClaimableVaults,
  getStaleProofVaults,
  getUnavailableVaults,
} from "./batchClaimUtils";

const API_BASE = getApiBaseUrl();

interface BatchClaimPreviewProps {
  vaultIds: string[];
  vaultMetadata: Record<string, { name: string }>;
}

/**
 * BatchClaimPreview — Multi-vault rewards claim preview component
 * Shows claimable rewards across multiple vaults with proof status
 */
export default function BatchClaimPreview({
  vaultIds,
  vaultMetadata,
}: BatchClaimPreviewProps) {
  const { isConnected, walletAddress } = useWallet();
  const [preview, setPreview] = useState<BatchClaimPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBatchPreview = useCallback(async () => {
    if (!walletAddress || vaultIds.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch proofs for all vaults in parallel
      const proofPromises = vaultIds.map(async (vaultId) => {
        try {
          const res = await fetch(
            `${API_BASE}/api/rewards/proof/${encodeURIComponent(walletAddress)}?vaultId=${vaultId}`,
          );

          if (res.status === 404) {
            return [vaultId, null] as const;
          }

          if (!res.ok) {
            throw new Error(`Failed to fetch proof for vault ${vaultId}`);
          }

          const data = await res.json();
          return [
            vaultId,
            {
              ...data,
              timestamp: data.timestamp || Date.now(),
            } as ClaimProofData,
          ] as const;
        } catch (err) {
          console.error(`Error fetching proof for vault ${vaultId}:`, err);
          return [vaultId, null] as const;
        }
      });

      const results = await Promise.all(proofPromises);
      const vaultProofs = Object.fromEntries(results);

      const batchPreview = buildBatchClaimPreview(vaultProofs, vaultMetadata);
      setPreview(batchPreview);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch batch preview",
      );
    } finally {
      setLoading(false);
    }
  }, [walletAddress, vaultIds, vaultMetadata]);

  useEffect(() => {
    if (isConnected && walletAddress) {
      void fetchBatchPreview();
    }
  }, [isConnected, walletAddress, fetchBatchPreview]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchBatchPreview();
    setRefreshing(false);
  };

  if (!isConnected) {
    return (
      <div className="glass-panel p-8 text-center">
        <Zap className="mx-auto mb-4 text-indigo-400" size={48} />
        <h2 className="text-xl font-bold mb-2">Claim Rewards Across Vaults</h2>
        <p className="text-gray-400">
          Connect your wallet to preview available rewards.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="glass-panel p-8 text-center">
        <div className="animate-spin inline-block mb-4">
          <Zap className="text-indigo-400" size={48} />
        </div>
        <p className="text-gray-400">Loading batch preview...</p>
      </div>
    );
  }

  if (!preview) {
    return null;
  }

  const claimableVaults = getClaimableVaults(preview.vaults);
  const staleVaults = getStaleProofVaults(preview.vaults);
  const unavailableVaults = getUnavailableVaults(preview.vaults);

  return (
    <div className="space-y-6">
      {/* Summary Card */}
      <div className="glass-panel p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Batch Claim Preview</h2>
          <button
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
            title="Refresh preview"
          >
            <RefreshCw size={20} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white/5 rounded-lg p-4">
            <p className="text-gray-400 text-sm mb-1">Total Claimable</p>
            <p className="text-2xl font-bold text-white">
              {formatYieldAmount(preview.totalClaimable)}{" "}
              <span className="text-indigo-400 text-lg">$YIELD</span>
            </p>
          </div>

          <div className="bg-white/5 rounded-lg p-4">
            <p className="text-gray-400 text-sm mb-1">Estimated Fees</p>
            <p className="text-2xl font-bold text-white">
              {formatYieldAmount(preview.totalEstimatedFees)}{" "}
              <span className="text-indigo-400 text-lg">$YIELD</span>
            </p>
          </div>
        </div>

        {/* Status Indicators */}
        <div className="flex gap-2 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
            <CheckCircle2 size={16} className="text-green-400" />
            <span className="text-sm text-green-400">
              {claimableVaults.length} ready to claim
            </span>
          </div>

          {staleVaults.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
              <Clock size={16} className="text-yellow-400" />
              <span className="text-sm text-yellow-400">
                {staleVaults.length} stale proof
                {staleVaults.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}

          {unavailableVaults.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle size={16} className="text-red-400" />
              <span className="text-sm text-red-400">
                {unavailableVaults.length} unavailable
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <AlertCircle className="text-red-400 shrink-0" size={20} />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Vault Status List */}
      <div className="glass-panel p-6 space-y-3">
        <h3 className="text-lg font-semibold mb-4">Vault Status</h3>

        {preview.vaults.map((vault) => (
          <div
            key={vault.vaultId}
            className="flex items-center justify-between p-4 bg-white/5 rounded-lg border border-white/10"
          >
            <div className="flex-1">
              <p className="font-medium text-white">{vault.vaultName}</p>
              <p className="text-sm text-gray-400">
                {formatYieldAmount(vault.claimableAmount)} $YIELD
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-xs text-gray-500">Fee</p>
                <p className="text-sm text-gray-300">
                  {formatYieldAmount(vault.estimatedFee)} $YIELD
                </p>
              </div>

              {vault.status === "claimable" && (
                <div className="flex items-center gap-1 px-2 py-1 bg-green-500/20 rounded">
                  <CheckCircle2 size={16} className="text-green-400" />
                  <span className="text-xs text-green-400">Ready</span>
                </div>
              )}

              {vault.status === "stale_proof" && (
                <div className="flex items-center gap-1 px-2 py-1 bg-yellow-500/20 rounded">
                  <Clock size={16} className="text-yellow-400" />
                  <span className="text-xs text-yellow-400">Stale</span>
                </div>
              )}

              {vault.status === "unavailable" && (
                <div className="flex items-center gap-1 px-2 py-1 bg-red-500/20 rounded">
                  <AlertCircle size={16} className="text-red-400" />
                  <span className="text-xs text-red-400">Missing</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Warnings */}
      {staleVaults.length > 0 && (
        <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4">
          <Clock className="text-yellow-400 shrink-0 mt-0.5" size={20} />
          <div>
            <p className="font-semibold text-yellow-400 mb-1">
              Stale Proof Data
            </p>
            <p className="text-sm text-yellow-300">
              {staleVaults.map((v) => v.vaultName).join(", ")} have proofs older
              than 24 hours. Refresh to get updated proofs before claiming.
            </p>
          </div>
        </div>
      )}

      {unavailableVaults.length > 0 && (
        <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={20} />
          <div>
            <p className="font-semibold text-red-400 mb-1">
              Missing Claim Data
            </p>
            <p className="text-sm text-red-300">
              {unavailableVaults.map((v) => v.vaultName).join(", ")} have no
              available rewards or proof data.
            </p>
          </div>
        </div>
      )}

      {/* Action Button */}
      <button
        disabled={!preview.canClaimAll}
        className="w-full py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.98]"
      >
        <div className="flex items-center justify-center gap-2">
          <Zap size={20} />
          {preview.canClaimAll
            ? "Claim All Rewards"
            : "Cannot Claim - Resolve Issues Above"}
        </div>
      </button>
    </div>
  );
}
