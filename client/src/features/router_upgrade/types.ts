export type RouterUpgradeErrorCode =
  | "EMPTY_ADDRESS"
  | "INVALID_ADDRESS_FORMAT"
  | "IDENTICAL_ROUTER"
  | "CONTRACT_NOT_FOUND"
  | "INTERFACE_MISMATCH"
  | "SIMULATION_REVERTED"
  | "RPC_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface RouterUpgradeError {
  code: RouterUpgradeErrorCode;
  message: string;
  remediation: string;
  providerDetails?: string;
}

export interface RouterUpgradeCheck {
  id: "address_format" | "different_address" | "contract_exists" | "interface_conformance" | "invocation_dry_run";
  label: string;
  passed: boolean;
  message: string;
  latencyMs?: number;
}

export interface RouterUpgradeDryRunInput {
  candidateRouterAddress: string;
  currentRouterAddress?: string;
  targetContract?: string;
  testTokenIn?: string;
  testTokenOut?: string;
  testAmountStroops?: string;
  network?: "testnet" | "mainnet" | "local";
  mockSimulate?: boolean;
}

export interface RouterUpgradeDryRunResult {
  success: boolean;
  status: "READY" | "BLOCKED" | "WARNING";
  summary: string;
  candidateRouterAddress: string;
  currentRouterAddress: string | null;
  targetContract: string;
  checks: RouterUpgradeCheck[];
  simulation?: {
    expectedAmountOutStroops: string;
    simulatedCpuInstructions?: number;
    simulatedMemoryBytes?: number;
    simulatedFeeStroops?: string;
  };
  error?: RouterUpgradeError;
  timestamp: string;
}

export interface RouterStatusResponse {
  activeRouterAddress: string | null;
  network: string;
  rpcConfigured: boolean;
  simSourceConfigured: boolean;
  timestamp: string;
}
