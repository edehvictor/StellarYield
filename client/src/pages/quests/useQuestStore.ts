import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import type { Quest, Achievement } from "./types";
import {
  QUEST_STORAGE_VERSION,
  applySimulatedIndexerProgress,
  cloneQuests,
  loadWalletQuestBundle,
  saveWalletQuestBundle,
} from "./questPersistence";

export type ProgressVerification =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "verified"; at: number }
  | { status: "error"; message: string };

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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useQuestStore(walletAddress: string | null) {
  const walletRef = useRef(walletAddress);
  walletRef.current = walletAddress;

  const [quests, setQuests] = useState<Quest[]>(() => cloneQuests(INITIAL_QUESTS));
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [progressVerification, setProgressVerification] =
    useState<ProgressVerification>({ status: "idle" });
  const [isMinting, setIsMinting] = useState(false);

  /** Restore display-safe snapshot when the active wallet changes (or session reloads). */
  useLayoutEffect(() => {
    if (!walletAddress) {
      setQuests(cloneQuests(INITIAL_QUESTS));
      setAchievements([]);
      setLastSyncedAt(null);
      setProgressVerification({ status: "idle" });
      return;
    }

    const bundle = loadWalletQuestBundle(walletAddress, INITIAL_QUESTS);
    setQuests(bundle.quests);
    setAchievements(bundle.achievements);
    setLastSyncedAt(bundle.lastSyncedAt);
    setProgressVerification({ status: "idle" });
  }, [walletAddress]);

  /** Persist display-only progress per wallet. */
  useEffect(() => {
    if (!walletAddress) return;
    saveWalletQuestBundle(walletAddress, {
      version: QUEST_STORAGE_VERSION,
      quests,
      achievements,
      lastSyncedAt,
    });
  }, [walletAddress, quests, achievements, lastSyncedAt]);

  /**
   * Simulate indexer verification of on-chain objectives.
   * In production this would call the indexer API and verify server-side.
   * The server must be the source of truth — never trust client-side progress.
   */
  const refreshProgress = useCallback(async (address: string, signal?: AbortSignal) => {
    if (!address) return;

    setProgressVerification({ status: "loading" });

    try {
      await delay(800, signal);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return;
      }
      setProgressVerification({
        status: "error",
        message: e instanceof Error ? e.message : "Could not refresh progress.",
      });
      return;
    }

    if (signal?.aborted || walletRef.current !== address) return;

    try {
      setQuests((prev) => applySimulatedIndexerProgress(prev));
      const now = Date.now();
      setLastSyncedAt(now);
      setProgressVerification({ status: "verified", at: now });
    } catch (e) {
      setProgressVerification({
        status: "error",
        message: e instanceof Error ? e.message : "Could not refresh progress.",
      });
    }
  }, []);

  /** After connect / reconnect, verify progress without blocking cached UI (see stale banner). */
  useEffect(() => {
    if (!walletAddress) return;
    const ac = new AbortController();
    void refreshProgress(walletAddress, ac.signal);
    return () => ac.abort();
  }, [walletAddress, refreshProgress]);

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

        const addr = walletRef.current;
        if (addr) {
          await refreshProgress(addr);
        }

        return fakeTxHash;
      } finally {
        setIsMinting(false);
      }
    },
    [quests, refreshProgress],
  );

  const totalPoints = achievements.reduce((sum, a) => {
    const q = quests.find((q) => q.id === a.questId);
    return sum + (q?.points ?? 0);
  }, 0);

  const isProgressVerifying = progressVerification.status === "loading";
  const showStaleProgressBanner =
    isProgressVerifying && lastSyncedAt !== null;

  return {
    quests,
    achievements,
    isMinting,
    lastSyncedAt,
    progressVerification,
    isProgressVerifying,
    showStaleProgressBanner,
    refreshProgress,
    mintBadge,
    totalPoints,
  };
}
