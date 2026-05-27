export type AccountActivityEventType =
  | "deposit"
  | "withdrawal"
  | "reward"
  | "recommendation"
  | "alert"
  | "rebalance";

export interface AccountActivityEvent {
  id: string;
  walletAddress: string;
  type: AccountActivityEventType;
  title: string;
  description: string;
  timestamp: string;
  source: "portfolio" | "rewards" | "advisor" | "monitoring" | "automation";
  amountUsd?: number;
  assetSymbol?: string;
  severity?: "info" | "warning" | "critical";
  relatedVaultId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
