import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Trophy, RefreshCw, Star, Award, AlertCircle, Loader2 } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import { useQuestStore } from "./useQuestStore";
import QuestCard from "./QuestCard";
import BadgeUnlockAnimation from "./BadgeUnlockAnimation";
import type { QuestStatus } from "./types";

const FILTERS: { label: string; value: QuestStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Claimable", value: "claimable" },
  { label: "Completed", value: "completed" },
];

/**
 * Main Quest & Achievement dashboard page.
 *
 * Queries the indexer (simulated) to verify on-chain objective completion,
 * then allows users to mint exclusive Achievement Badge NFTs via Soroban.
 *
 * Security: all completion verification is done server-side via the indexer.
 * The Soroban contract is the final authority — client-side state is display only.
 */
export default function QuestsDashboard() {
  const { walletAddress, isConnected } = useWallet();
  const scopedWallet = isConnected && walletAddress ? walletAddress : null;
  const {
    quests,
    achievements,
    isMinting,
    refreshProgress,
    mintBadge,
    totalPoints,
    progressVerification,
    isProgressVerifying,
    showStaleProgressBanner,
  } = useQuestStore(scopedWallet);

  const [filter, setFilter] = useState<QuestStatus | "all">("all");
  const [celebration, setCelebration] = useState<{
    show: boolean;
    title: string;
    points: number;
  }>({ show: false, title: "", points: 0 });

  const handleRefresh = useCallback(async () => {
    if (!walletAddress) return;
    await refreshProgress(walletAddress);
  }, [walletAddress, refreshProgress]);

  async function handleClaim(questId: string) {
    if (!walletAddress) return;
    const quest = quests.find((q) => q.id === questId);
    if (!quest) return;
    try {
      await mintBadge(questId);
      setCelebration({ show: true, title: quest.title, points: quest.points });
    } catch (e) {
      console.error("Mint failed", e);
    }
  }

  const filtered = quests.filter(
    (q) => filter === "all" || q.status === filter
  );

  const claimableCount = quests.filter((q) => q.status === "claimable").length;
  const completedCount = quests.filter((q) => q.status === "completed").length;

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Trophy size={52} className="text-indigo-400 mb-4" />
        <h2 className="text-2xl font-bold mb-2">Quests & Achievements</h2>
        <p className="text-gray-400 max-w-sm">
          Connect your Freighter wallet to track your on-chain quests and mint
          exclusive Achievement Badge NFTs.
        </p>
      </div>
    );
  }

  return (
    <>
      <BadgeUnlockAnimation
        show={celebration.show}
        questTitle={celebration.title}
        points={celebration.points}
        onDone={() => setCelebration((c) => ({ ...c, show: false }))}
      />

      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        {/* Header */}
        <header className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h2 className="text-3xl font-extrabold tracking-tight">Quests</h2>
            <p className="text-gray-400 mt-1">
              Complete on-chain objectives to earn Achievement Badge NFTs
            </p>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isProgressVerifying}
            className="btn-secondary flex items-center gap-2 text-sm px-4 py-2"
          >
            <RefreshCw size={15} className={isProgressVerifying ? "animate-spin" : ""} />
            {isProgressVerifying ? "Syncing..." : "Sync Progress"}
          </button>
        </header>

        {progressVerification.status === "error" && (
          <div
            role="alert"
            className="glass-card border border-red-500/40 bg-red-950/30 px-4 py-3 flex items-start gap-3 text-sm text-red-100"
          >
            <AlertCircle size={18} className="shrink-0 mt-0.5 text-red-400" />
            <div>
              <p className="font-medium">Could not refresh quest progress</p>
              <p className="text-red-200/80 mt-1">{progressVerification.message}</p>
            </div>
          </div>
        )}

        {isProgressVerifying && (
          <div
            className={`glass-card px-4 py-3 flex items-center gap-3 text-sm ${
              showStaleProgressBanner
                ? "border border-amber-500/35 bg-amber-950/25 text-amber-100"
                : "border border-indigo-500/25 bg-indigo-950/20 text-indigo-100"
            }`}
          >
            <Loader2 size={18} className="animate-spin shrink-0 text-indigo-300" />
            <span>
              {showStaleProgressBanner
                ? "Showing saved progress while verifying with the indexer…"
                : "Loading quest progress from the indexer…"}
            </span>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass-card border-l-4 border-indigo-500 p-5">
            <p className="text-sm text-gray-400">Total XP</p>
            <p className="text-2xl font-bold mt-1 flex items-center gap-2">
              <Star size={18} className="text-indigo-400" /> {totalPoints}
            </p>
          </div>
          <div className="glass-card border-l-4 border-yellow-500 p-5">
            <p className="text-sm text-gray-400">Claimable</p>
            <p className="text-2xl font-bold mt-1">{claimableCount}</p>
          </div>
          <div className="glass-card border-l-4 border-green-500 p-5">
            <p className="text-sm text-gray-400">Badges Earned</p>
            <p className="text-2xl font-bold mt-1 flex items-center gap-2">
              <Award size={18} className="text-green-400" /> {completedCount}
            </p>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                filter === f.value
                  ? "bg-indigo-600 text-white"
                  : "bg-white/5 text-gray-400 hover:bg-white/10"
              }`}
            >
              {f.label}
              {f.value === "claimable" && claimableCount > 0 && (
                <span className="ml-1.5 bg-yellow-500 text-black text-xs rounded-full px-1.5 py-0.5 font-bold">
                  {claimableCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Quest grid */}
        <motion.div
          layout
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5"
        >
          {filtered.map((quest) => (
            <QuestCard
              key={quest.id}
              quest={quest}
              onClaim={handleClaim}
              isMinting={isMinting}
              progressPending={isProgressVerifying}
            />
          ))}
        </motion.div>

        {/* Achievements history */}
        {achievements.length > 0 && (
          <section>
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Award size={18} className="text-green-400" /> Minted Badges
            </h3>
            <div className="space-y-2">
              {achievements.map((a) => (
                <div
                  key={a.txHash}
                  className="glass-card p-4 flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3">
                    <Trophy size={18} className="text-indigo-400 shrink-0" />
                    <div>
                      <p className="font-medium text-sm">{a.title}</p>
                      <p className="text-xs text-gray-500 font-mono truncate max-w-[200px]">
                        {a.txHash}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0">
                    {new Date(a.mintedAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
