import React, { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../context/useWallet";
import {
  Users,
  Copy,
  CheckCircle,
  Loader2,
  Gift,
  AlertCircle,
  Link as LinkIcon,
  UserPlus,
} from "lucide-react";

interface ReferralData {
  referredTvl: number;
  unclaimedRewards: number;
  totalReferrals: number;
  referralLink: string;
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";
const APP_URL = import.meta.env.VITE_APP_URL || "https://stellaryield.vercel.app";

/**
 * ReferralDashboard — User dashboard for the referral & affiliate system.
 *
 * Allows users to generate a unique referral link, view their referred TVL,
 * and claim accumulated referral rewards.
 */
export default function ReferralDashboard() {
  const { isConnected, walletAddress } = useWallet();
  const [referralData, setReferralData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [referralCodeInput, setReferralCodeInput] = useState("");

  const referralLink = walletAddress
    ? `${APP_URL}/?ref=${encodeURIComponent(walletAddress)}`
    : "";

  const fetchReferralData = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/referrals/${encodeURIComponent(walletAddress)}`,
      );
      if (!res.ok) throw new Error("Failed to fetch referral data");
      const data: ReferralData = await res.json();
      setReferralData(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch referral data",
      );
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (isConnected && walletAddress) {
      void fetchReferralData();
    }
  }, [isConnected, walletAddress, fetchReferralData]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = referralLink;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClaimRewards = async () => {
    if (!walletAddress) return;
    setClaiming(true);
    setError(null);
    setClaimSuccess(false);

    try {
      const res = await fetch(`${API_BASE}/api/referrals/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: walletAddress }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error || "Claim failed",
        );
      }
      setClaimSuccess(true);
      void fetchReferralData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setClaiming(false);
    }
  };

  const handleApplyReferral = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddress) return;
    
    setSubmitError(null);
    setSubmitSuccess(false);
    
    if (!/^[GC][A-Z2-7]{55}$/.test(referralCodeInput)) {
      setSubmitError("Invalid referral code format. Must be a valid Stellar address.");
      return;
    }
    
    if (referralCodeInput === walletAddress) {
      setSubmitError("Self-referral is not allowed.");
      return;
    }
    
    setSubmitting(true);
    
    try {
      const res = await fetch(`${API_BASE}/api/referrals/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: walletAddress, referralCode: referralCodeInput }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Submission failed");
      }
      setSubmitSuccess(true);
      setReferralCodeInput("");
      void fetchReferralData();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="glass-panel p-8 text-center">
        <Users className="mx-auto mb-4 text-indigo-400" size={48} />
        <h2 className="text-xl font-bold mb-2">Referral Program</h2>
        <p className="text-gray-400">
          Connect your wallet to access your referral dashboard.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="glass-panel p-8 text-center">
        <Loader2 className="mx-auto mb-4 animate-spin text-indigo-400" size={48} />
        <p className="text-gray-400">Loading referral data...</p>
      </div>
    );
  }

  return (
    <div className="glass-panel p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Users className="text-indigo-400" size={28} />
        <h2 className="text-xl font-bold">Referral Program</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
          <AlertCircle className="text-red-400 shrink-0" size={18} />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {claimSuccess && (
        <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-xl p-3">
          <CheckCircle className="text-green-400 shrink-0" size={18} />
          <p className="text-green-400 text-sm">Rewards claimed successfully!</p>
        </div>
      )}

      {/* Referral Link */}
      <div className="bg-white/5 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <LinkIcon className="text-indigo-400" size={16} />
          <p className="text-gray-400 text-sm font-medium">
            Your Referral Link
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={referralLink}
            className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono truncate"
          />
          <button
            onClick={() => void handleCopy()}
            className="px-4 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg text-sm font-medium transition-all flex items-center gap-1"
          >
            {copied ? (
              <>
                <CheckCircle size={14} />
                Copied!
              </>
            ) : (
              <>
                <Copy size={14} />
                Copy
              </>
            )}
          </button>
        </div>
        <p className="text-gray-500 text-xs mt-2">
          Share this link. When someone deposits via your link, you earn a
          percentage of the protocol fees they generate.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white/5 rounded-xl p-4">
          <p className="text-gray-400 text-xs mb-1">Referred TVL</p>
          <p className="text-2xl font-bold text-white">
            ${fmtUsd(referralData?.referredTvl ?? 0)}
          </p>
        </div>
        <div className="bg-white/5 rounded-xl p-4">
          <p className="text-gray-400 text-xs mb-1">Total Referrals</p>
          <p className="text-2xl font-bold text-white">
            {referralData?.totalReferrals ?? 0}
          </p>
        </div>
        <div className="bg-white/5 rounded-xl p-4">
          <p className="text-gray-400 text-xs mb-1">Unclaimed Rewards</p>
          <p className="text-2xl font-bold text-green-400">
            ${fmtUsd(referralData?.unclaimedRewards ?? 0)}
          </p>
        </div>
      </div>

      {/* Claim Button */}
      <button
        onClick={() => void handleClaimRewards()}
        disabled={claiming || (referralData?.unclaimedRewards ?? 0) <= 0}
        className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {claiming ? (
          <>
            <Loader2 className="animate-spin" size={18} />
            Claiming...
          </>
        ) : (
          <>
            <Gift size={18} />
            Claim Referral Rewards
          </>
        )}
      </button>

      {/* Apply Referral Code Section */}
      <div className="bg-white/5 rounded-xl p-4 mt-6">
        <div className="flex items-center gap-2 mb-4">
          <UserPlus className="text-indigo-400" size={16} />
          <h3 className="text-sm font-medium text-white">Have a referral code?</h3>
        </div>
        
        {submitError && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4">
            <AlertCircle className="text-red-400 shrink-0" size={18} />
            <p className="text-red-400 text-sm">{submitError}</p>
          </div>
        )}

        {submitSuccess && (
          <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-xl p-3 mb-4">
            <CheckCircle className="text-green-400 shrink-0" size={18} />
            <p className="text-green-400 text-sm">Referral code applied successfully!</p>
          </div>
        )}

        <form onSubmit={handleApplyReferral} className="flex gap-2">
          <input
            type="text"
            value={referralCodeInput}
            onChange={(e) => setReferralCodeInput(e.target.value)}
            placeholder="Enter Stellar address (G...)"
            className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 transition-colors"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={submitting || !referralCodeInput}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[100px]"
          >
            {submitting ? <Loader2 className="animate-spin" size={16} /> : "Apply"}
          </button>
        </form>
      </div>
    </div>
  );
}

function fmtUsd(n: number): string {
  return n
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
