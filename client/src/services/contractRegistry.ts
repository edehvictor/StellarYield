/**
 * Contract address registry (#185).
 *
 * Resolves Soroban contract IDs for the active network. Environment variables
 * always override registry values so deployers can inject addresses without
 * modifying the JSON file.
 *
 * Priority (highest → lowest):
 *   1. VITE_* environment variables
 *   2. contracts/registry.json for the active network
 *   3. Empty string (caller must handle missing IDs)
 */

import registryJson from "../../../contracts/registry.json";

export type ContractName =
  | "vault"
  | "zap"
  | "token"
  | "governance"
  | "strategy"
  | "emissionController"
  | "liquidStaking"
  | "stableswap";

export type NetworkName = "testnet" | "mainnet" | "local";

type Registry = Record<NetworkName, Record<ContractName, string>>;

const registry = registryJson as Registry;

function detectNetwork(): NetworkName {
  const passphrase =
    import.meta.env.VITE_NETWORK_PASSPHRASE ?? "";
  if (passphrase.includes("mainnet") || passphrase.includes("Public Global")) {
    return "mainnet";
  }
  if (passphrase === "" || passphrase.includes("local") || passphrase.includes("standalone")) {
    return "local";
  }
  return "testnet";
}

const ENV_OVERRIDES: Partial<Record<ContractName, string | undefined>> = {
  vault: import.meta.env.VITE_CONTRACT_ID,
  zap: import.meta.env.VITE_ZAP_CONTRACT_ID,
  token: import.meta.env.VITE_TOKEN_CONTRACT_ID,
  governance: import.meta.env.VITE_GOVERNANCE_CONTRACT_ID,
  strategy: import.meta.env.VITE_STRATEGY_CONTRACT_ID,
  emissionController: import.meta.env.VITE_EMISSION_CONTROLLER_CONTRACT_ID,
  liquidStaking: import.meta.env.VITE_LIQUID_STAKING_CONTRACT_ID,
  stableswap: import.meta.env.VITE_STABLESWAP_CONTRACT_ID,
};

export function getContractId(
  name: ContractName,
  network?: NetworkName,
): string {
  const envOverride = ENV_OVERRIDES[name];
  if (envOverride) return envOverride;

  const net = network ?? detectNetwork();
  return registry[net]?.[name] ?? "";
}

export function getAllContractIds(network?: NetworkName): Record<ContractName, string> {
  const net = network ?? detectNetwork();
  const names: ContractName[] = [
    "vault", "zap", "token", "governance", "strategy",
    "emissionController", "liquidStaking", "stableswap",
  ];
  return Object.fromEntries(
    names.map((n) => [n, getContractId(n, net)]),
  ) as Record<ContractName, string>;
}
