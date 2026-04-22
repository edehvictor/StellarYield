import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../context/useWallet";
import { Gift, CheckCircle, Loader2, AlertCircle } from "lucide-react";

interface ClaimData {
  index: number;
  amount: string;
  proof: string[];
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

/**
 * ClaimRewards — Frontend UI for claiming Merkle-tree distributed $YIELD rewards.
 *
 * Connects the user's wallet, fetches their proof from the backend,
 * and executes the on-chain claim transaction.
 */
export default function ClaimRewards() {
  const { isConnected, walletAddress } = useWallet();
  const [claimData, setClaimData] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchClaimData = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/rewards/proof/${encodeURIComponent(walletAddress)}`,
      );
      if (res.status === 404) {
        setClaimData(null);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        throw new Error("Failed to fetch claim data");
      }
      const data: ClaimData = await res.json();
      setClaimData(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch claim data",
      );
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (isConnected && walletAddress) {
      void fetchClaimData();
    }
  }, [isConnected, walletAddress, fetchClaimData]);

  const handleClaim = async () => {
    if (!claimData || !walletAddress) return;
    setClaiming(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/rewards/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          index: claimData.index,
          amount: claimData.amount,
          proof: claimData.proof,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error || "Claim transaction failed",
        );
      }

      setClaimed(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Claim transaction failed",
      );
    } finally {
      setClaiming(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="glass-panel p-8 text-center">
        <Gift className="mx-auto mb-4 text-indigo-400" size={48} />
        <h2 className="text-xl font-bold mb-2">Claim Your $YIELD Rewards</h2>
        <p className="text-gray-400">
          Connect your wallet to check for available rewards.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="glass-panel p-8 text-center">
        <Loader2 className="mx-auto mb-4 animate-spin text-indigo-400" size={48} />
        <p className="text-gray-400">Checking for available rewards...</p>
      </div>
    );
  }

  if (claimed) {
    return (
      <div className="glass-panel p-8 text-center">
        <CheckCircle className="mx-auto mb-4 text-green-400" size={48} />
        <h2 className="text-xl font-bold mb-2">Rewards Claimed!</h2>
        <p className="text-gray-400">
          Your $YIELD rewards have been sent to your wallet.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-panel p-8">
      <div className="flex items-center gap-3 mb-6">
        <Gift className="text-indigo-400" size={28} />
        <h2 className="text-xl font-bold">Claim Your $YIELD Rewards</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6">
          <AlertCircle className="text-red-400 shrink-0" size={20} />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {!claimData ? (
        <div className="text-center py-8">
          <p className="text-gray-400 mb-2">No rewards available to claim.</p>
          <p className="text-gray-500 text-sm">
            Rewards are distributed weekly based on your vault share balance.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-white/5 rounded-xl p-6">
            <p className="text-gray-400 text-sm mb-1">Available Reward</p>
            <p className="text-3xl font-bold text-white">
              {formatYieldAmount(claimData.amount)}{" "}
              <span className="text-indigo-400 text-lg">$YIELD</span>
            </p>
          </div>

          <div className="bg-white/5 rounded-xl p-4">
            <p className="text-gray-400 text-xs mb-1">Wallet</p>
            <p className="text-white text-sm font-mono truncate">
              {walletAddress}
            </p>
          </div>

          <button
            onClick={() => void handleClaim()}
            disabled={claiming}
            className="w-full py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {claiming ? (
              <>
                <Loader2 className="animate-spin" size={20} />
                Claiming...
              </>
            ) : (
              <>
                <Gift size={20} />
                Claim Rewards
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Format a stroop amount to a human-readable YIELD amount.
 * 1 YIELD = 10^7 stroops.
 */
function formatYieldAmount(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / BigInt(10_000_000);
  const fractional = value % BigInt(10_000_000);
  const fracStr = fractional.toString().padStart(7, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
