export interface PendingTransaction {
  id: string;
  description: string;
  method: string;
  args: string[];
  xdr: string;
  signatures: SignerRecord[];
  threshold: number;
  createdAt: number;
  createdBy: string;
  status: "pending" | "ready" | "executed" | "expired";
}

export interface SignerRecord {
  publicKey: string;
  signedAt: number;
}

export interface GovernanceConfig {
  signers: string[];
  threshold: number;
  contractId: string;
}

export type AdminAction =
  | "emergency_pause"
  | "emergency_unpause"
  | "set_keeper_fee"
  | "set_fee_bounds"
  | "register_keeper"
  | "remove_keeper"
  | "rescue_funds"
  | "set_admin";

export interface AdminActionOption {
  label: string;
  method: AdminAction;
  description: string;
  fields: ActionField[];
}

export interface ActionField {
  name: string;
  label: string;
  type: "address" | "number" | "text";
  placeholder: string;
  required: boolean;
}
