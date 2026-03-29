import { motion } from "framer-motion";
import {
  Landmark, Gem, Sprout, ShieldCheck, TrendingUp, Waves,
  CheckCircle2, Lock, Loader2, Trophy,
} from "lucide-react";
import type { Quest } from "./types";

// ── Icon map ─────────────────────────────────────────────────────────────

const ICONS: Record<string, React.ReactNode> = {
  Landmark: <Landmark size={20} />,
  Gem: <Gem size={20} />,
  Sprout: <Sprout size={20} />,
  ShieldCheck: <ShieldCheck size={20} />,
  TrendingUp: <TrendingUp size={20} />,
  Waves: <Waves size={20} />,
};

const CATEGORY_COLORS: Record<string, string> = {
  deposit:    "from-indigo-500/80 to-purple-600/80",
  hold:       "from-cyan-500/80 to-blue-600/80",
  trade:      "from-amber-500/80 to-orange-600/80",
  governance: "from-emerald-500/80 to-teal-600/80",
  social:     "from-pink-500/80 to-rose-600/80",
};

interface Props {
  quest: Quest;
  onClaim: (questId: string) => void;
  isMinting: boolean;
}

/**
 * Renders a single quest card with progress bar and claim button.
 */
export default function QuestCard({ quest, onClaim, isMinting }: Props) {
  const obj = quest.objectives[0];
  const pct = Math.min(100, Math.round((obj.progress / obj.target) * 100));
  const isLocked = quest.status === "locked";
  const isCompleted = quest.status === "completed";
  const isClaimable = quest.status === "claimable";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass-card p-5 flex flex-col gap-4 ${isLocked ? "opacity-50" : ""}`}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${CATEGORY_COLORS[quest.category]} flex items-center justify-center shrink-0`}>
          {ICONS[quest.icon]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-white truncate">{quest.title}</h3>
            {isCompleted && <CheckCircle2 size={15} className="text-green-400 shrink-0" />}
            {isLocked && <Lock size={14} className="text-gray-500 shrink-0" />}
          </div>
          <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{quest.description}</p>
        </div>
        <span className="text-xs font-bold text-indigo-300 shrink-0">{quest.points} XP</span>
      </div>

      {/* Progress */}
      {!isLocked && !isCompleted && (
        <div>
          <div className="flex justify-between text-xs text-gray-400 mb-1.5">
            <span>{obj.description}</span>
            <span>{obj.progress} / {obj.target} {obj.unit}</span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          </div>
        </div>
      )}

      {/* Claim button */}
      {isClaimable && (
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={() => onClaim(quest.id)}
          disabled={isMinting}
          className="btn-primary w-full flex items-center justify-center gap-2 text-sm"
        >
          {isMinting ? (
            <><Loader2 size={15} className="animate-spin" /> Minting Badge...</>
          ) : (
            <><Trophy size={15} /> Claim Badge NFT</>
          )}
        </motion.button>
      )}

      {isCompleted && (
        <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
          <CheckCircle2 size={15} /> Badge Minted
        </div>
      )}
    </motion.div>
  );
}
