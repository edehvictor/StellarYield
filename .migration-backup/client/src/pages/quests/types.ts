// ── Quest & Achievement Types ────────────────────────────────────────────

export type QuestStatus = "locked" | "active" | "completed" | "claimable";

export interface QuestObjective {
  id: string;
  description: string;
  /** Target value (e.g. 100 for "Deposit 100 USDC") */
  target: number;
  /** Current progress fetched from the indexer */
  progress: number;
  unit: string;
}

export interface Quest {
  id: string;
  title: string;
  description: string;
  objectives: QuestObjective[];
  /** XP / points awarded on completion */
  points: number;
  status: QuestStatus;
  /** Badge NFT contract address on Soroban */
  badgeContractId: string;
  /** Category tag */
  category: "deposit" | "hold" | "trade" | "governance" | "social";
  /** Icon name from lucide-react */
  icon: string;
}

export interface Achievement {
  questId: string;
  title: string;
  badgeContractId: string;
  mintedAt: number; // ledger timestamp
  txHash: string;
}
