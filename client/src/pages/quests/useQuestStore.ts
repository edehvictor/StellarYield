import { useState, useEffect, useCallback } from "react";
import type { Quest, Achievement } from "./types";

// ── Mock quest definitions ───────────────────────────────────────────────
// In production these would be fetched from the indexer / backend.

const INITIAL_QUESTS: Quest[] = [
  {
    id: "q1",
    title: "First Deposit",
    description: "Make your first USDC deposit into a StellarYield vault.",
    points: 50,
    status: "active",
    badgeContractId: "CBADGE_FIRST_DEPOSIT",
    category: "deposit",
    icon: "Landmark",
    objectives: [
      { id: "o1", description: "Deposit 100 USDC", target: 100, progress: 0, unit: "USDC" },
    ],
  },
  {
    id: "q2",
    title: "Diamond Hands",
    description: "Hold your vault position for 30 consecutive days.",
    points: 150,
    status: "active",
    badgeContractId: "CBADGE_DIAMOND_HANDS",
    category: "hold",
    icon: "Gem",
    objectives: [
      { id: "o2", description: "Hold for 30 days", target: 30, progress: 0, unit: "days" },
    ],
  },
  {
    id: "q3",
    title: "Yield Farmer",
    description: "Accumulate $500 in total yield across all vaults.",
    points: 200,
    status: "locked",
    badgeContractId: "CBADGE_YIELD_FARMER",
    category: "deposit",
    icon: "Sprout",
    objectives: [
      { id: "o3", description: "Earn $500 in yield", target: 500, progress: 0, unit: "USDC" },
    ],
  },
  {
    id: "q4",
    title: "Governance Voter",
    description: "Vote on 3 governance proposals.",
    points: 100,
    status: "active",
    badgeContractId: "CBADGE_VOTER",
    category: "governance",
    icon: "ShieldCheck",
    objectives: [
      { id: "o4", description: "Vote on proposals", target: 3, progress: 1, unit: "votes" },
    ],
  },
  {
    id: "q5",
    title: "Delta Neutral Pioneer",
    description: "Open a delta-neutral basis trade position.",
    points: 300,
    status: "locked",
    badgeContractId: "CBADGE_DN_PIONEER",
    category: "trade",
    icon: "TrendingUp",
    objectives: [
      { id: "o5", description: "Open a delta-neutral position", target: 1, progress: 0, unit: "positions" },
    ],
  },
  {
    id: "q6",
    title: "Whale Alert",
    description: "Deposit 10,000 USDC in a single transaction.",
    points: 500,
    status: "locked",
    badgeContractId: "CBADGE_WHALE",
    category: "deposit",
    icon: "Waves",
    objectives: [
      { id: "o6", description: "Deposit 10,000 USDC at once", target: 10000, progress: 0, unit: "USDC" },
    ],
  },
];

const STORAGE_KEY = "sy_quests";
const ACHIEVEMENTS_KEY = "sy_achievements";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useQuestStore() {
  const [quests, setQuests] = useState<Quest[]>(() =>
    load(STORAGE_KEY, INITIAL_QUESTS)
  );
  const [achievements, setAchievements] = useState<Achievement[]>(() =>
    load(ACHIEVEMENTS_KEY, [])
  );
  const [isMinting, setIsMinting] = useState(false);

  useEffect(() => { save(STORAGE_KEY, quests); }, [quests]);
  useEffect(() => { save(ACHIEVEMENTS_KEY, achievements); }, [achievements]);

  /**
   * Simulate indexer verification of on-chain objectives.
   * In production this would call the indexer API and verify server-side.
   * The server must be the source of truth — never trust client-side progress.
   */
  const refreshProgress = useCallback(async (walletAddress: string) => {
    if (!walletAddress) return;

    // Simulate async indexer call
    await new Promise((r) => setTimeout(r, 800));

    setQuests((prev) =>
      prev.map((q) => {
        // Demo: simulate partial/full progress for active quests
        if (q.id === "q1") {
          const progress = 100; // pretend indexer confirmed 100 USDC deposit
          const completed = progress >= q.objectives[0].target;
          return {
            ...q,
            status: completed ? "claimable" : "active",
            objectives: [{ ...q.objectives[0], progress }],
          };
        }
        if (q.id === "q2") {
          const progress = 12;
          return {
            ...q,
            objectives: [{ ...q.objectives[0], progress }],
          };
        }
        if (q.id === "q4") {
          const progress = 3;
          const completed = progress >= q.objectives[0].target;
          return {
            ...q,
            status: completed ? "claimable" : "active",
            objectives: [{ ...q.objectives[0], progress }],
          };
        }
        return q;
      })
    );
  }, []);

  /**
   * Mint an achievement badge NFT via Soroban contract call.
   * The contract validates on-chain completion — client cannot spoof this.
   */
  const mintBadge = useCallback(
    async (questId: string): Promise<string> => {
      const quest = quests.find((q) => q.id === questId);
      if (!quest || quest.status !== "claimable") {
        throw new Error("Quest not claimable");
      }

      setIsMinting(true);
      try {
        // Simulate Soroban contract call to mint badge NFT
        await new Promise((r) => setTimeout(r, 1500));
        const fakeTxHash = `tx_${Math.random().toString(36).slice(2, 12)}`;

        const achievement: Achievement = {
          questId,
          title: quest.title,
          badgeContractId: quest.badgeContractId,
          mintedAt: Date.now(),
          txHash: fakeTxHash,
        };

        setAchievements((prev) => [...prev, achievement]);
        setQuests((prev) =>
          prev.map((q) =>
            q.id === questId ? { ...q, status: "completed" } : q
          )
        );

        return fakeTxHash;
      } finally {
        setIsMinting(false);
      }
    },
    [quests]
  );

  const totalPoints = achievements.reduce((sum, a) => {
    const q = quests.find((q) => q.id === a.questId);
    return sum + (q?.points ?? 0);
  }, 0);

  return { quests, achievements, isMinting, refreshProgress, mintBadge, totalPoints };
}
