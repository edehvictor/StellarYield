export interface SignerQuorumProgress {
  signed: number;
  required: number;
  remaining: number;
  /** Progress toward quorum as a percentage 0–100. */
  progressPct: number;
  met: boolean;
  perSigner: { address: string; signed: boolean }[];
}

import type { GovernanceExecutionState } from "./governanceOperation";

export interface PendingTransaction {
  id: string;
  /** Canonical governance configuration fingerprint bound to this proposal (#1894). */
  configFingerprint?: string;
  /** Durable execution checkpoint; survives reloads so retries can resume safely (#1899). */
  operation?: GovernanceExecutionState;
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
