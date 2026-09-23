/**
 * Contract address registry — server side (#185).
 *
 * Reads contract IDs from contracts/registry.json and applies process.env
 * overrides in the same priority order as the client-side version.
 *
 * When the registry file is missing, unreadable, or contains malformed JSON,
 * the loader falls back to a safe default record and records the failure so
 * callers can surface targeted warnings without blocking contract views.
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

// ── Safe Fallback Registry ────────────────────────────────────────────────
/**
 * Deterministic fallback record used when the primary registry file cannot
 * be loaded.  All addresses are empty strings so callers still receive a
 * valid shape they can iterate over without crashing.
 */
const SAFE_FALLBACK_REGISTRY: Registry = {
  testnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "" },
  mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "" },
  local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "" },
};

// ── Load State ────────────────────────────────────────────────────────────

export type RegistryLoadStatus = "ok" | "fallback" | "empty";

export interface RegistryLoadState {
  /** Whether the registry loaded from the real file or fell back. */
  status: RegistryLoadStatus;
  /** Human-readable cause when status is not "ok". */
  reason: string | null;
  /** ISO timestamp of when the registry was loaded. */
  loadedAt: string;
}

let loadState: RegistryLoadState = {
  status: "ok",
  reason: null,
  loadedAt: new Date().toISOString(),
};

/**
 * Returns the current registry load state so callers (API routes, tests)
 * can surface targeted warnings to the UI.
 */
export function getRegistryLoadState(): RegistryLoadState {
  return { ...loadState };
}

// ── Registry Loading ──────────────────────────────────────────────────────

const REGISTRY_PATH = path.resolve(
  __dirname,
  "../../../../contracts/registry.json",
);

function loadRegistry(): Registry {
  let raw: string;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const message = (err as Error).message ?? String(err);
    const reason =
      code === "ENOENT"
        ? `Registry file not found at ${REGISTRY_PATH}`
        : `Failed to read registry file: ${message}`;
    console.warn(`[contractRegistry] ${reason} — using safe fallback`);
    loadState = { status: "fallback", reason, loadedAt: new Date().toISOString() };
    return { ...SAFE_FALLBACK_REGISTRY };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const reason = `Registry file contains malformed JSON: ${(err as Error).message}`;
    console.warn(`[contractRegistry] ${reason} — using safe fallback`);
    loadState = { status: "fallback", reason, loadedAt: new Date().toISOString() };
    return { ...SAFE_FALLBACK_REGISTRY };
  }

  // Validate top-level shape: must be an object with at least one known network.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const reason = "Registry file has invalid structure (expected an object with network keys)";
    console.warn(`[contractRegistry] ${reason} — using safe fallback`);
    loadState = { status: "fallback", reason, loadedAt: new Date().toISOString() };
    return { ...SAFE_FALLBACK_REGISTRY };
  }

  const networks: NetworkName[] = ["testnet", "mainnet", "local"];
  const hasAnyNetwork = networks.some(
    (n) => n in (parsed as Record<string, unknown>),
  );
  if (!hasAnyNetwork) {
    const reason = "Registry file has no recognized network keys (testnet, mainnet, local)";
    console.warn(`[contractRegistry] ${reason} — using safe fallback`);
    loadState = { status: "fallback", reason, loadedAt: new Date().toISOString() };
    return { ...SAFE_FALLBACK_REGISTRY };
  }

  // Merge parsed data into the fallback so missing networks/contracts are filled.
  const registry: Registry = { ...SAFE_FALLBACK_REGISTRY };
  for (const net of networks) {
    const netData = (parsed as Record<string, unknown>)[net];
    if (netData !== null && typeof netData === "object" && !Array.isArray(netData)) {
      registry[net] = { ...SAFE_FALLBACK_REGISTRY[net], ...(netData as Record<ContractName, string>) };
    }
  }

  // Check for partial metadata — some networks present but all contracts empty.
  const totalContracts = networks.reduce(
    (sum, net) => sum + Object.values(registry[net]).filter((v) => v !== "").length,
    0,
  );

  if (totalContracts === 0) {
    loadState = { status: "empty", reason: "Registry loaded but contains no contract addresses", loadedAt: new Date().toISOString() };
  } else {
    loadState = { status: "ok", reason: null, loadedAt: new Date().toISOString() };
  }

  return registry;
}

const registry = loadRegistry();

// ── Network Detection & Resolution ────────────────────────────────────────

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
