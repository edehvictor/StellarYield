export type AlertCondition = "above" | "below";

export interface UserAlert {
  id: string;
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
  status: "active" | "triggered" | "deleted";
  triggeredAt: string | null;
  createdAt: string;
}

export interface CreateAlertPayload {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
}
