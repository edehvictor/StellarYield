/**
 * Contract address registry — server side (#185).
 *
 * Reads contract IDs from contracts/registry.json and applies process.env
 * overrides in the same priority order as the client-side version.
 */

import * as path from "path";
import * as fs from "fs";

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

const REGISTRY_PATH = path.resolve(
  __dirname,
  "../../../../contracts/registry.json",
);

function loadRegistry(): Registry {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as Registry;
  } catch {
    return { testnet: {} as Record<ContractName, string>, mainnet: {} as Record<ContractName, string>, local: {} as Record<ContractName, string> };
  }
}

const registry = loadRegistry();

function detectNetwork(): NetworkName {
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? "";
  if (passphrase.includes("mainnet") || passphrase.includes("Public Global")) {
    return "mainnet";
  }
  const horizon = process.env.STELLAR_HORIZON_URL ?? "";
  if (horizon.includes("testnet") || passphrase.includes("testnet")) {
    return "testnet";
  }
  if (horizon.includes("local") || horizon.includes("localhost")) {
    return "local";
  }
  return "testnet";
}

const ENV_OVERRIDES: Partial<Record<ContractName, string | undefined>> = {
  vault: process.env.CONTRACT_ID,
  zap: process.env.ZAP_CONTRACT_ID,
  token: process.env.TOKEN_CONTRACT_ID,
  governance: process.env.GOVERNANCE_CONTRACT_ID,
  strategy: process.env.STRATEGY_CONTRACT_ID,
  emissionController: process.env.EMISSION_CONTROLLER_CONTRACT_ID,
  liquidStaking: process.env.LIQUID_STAKING_CONTRACT_ID,
  stableswap: process.env.STABLESWAP_CONTRACT_ID,
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

export function getAllContractIds(
  network?: NetworkName,
): Record<ContractName, string> {
  const net = network ?? detectNetwork();
  const names: ContractName[] = [
    "vault", "zap", "token", "governance", "strategy",
    "emissionController", "liquidStaking", "stableswap",
  ];
  return Object.fromEntries(
    names.map((n) => [n, getContractId(n, net)]),
  ) as Record<ContractName, string>;
}
