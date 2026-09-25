/**
 * Cross-network environment resolver (#1284).
 *
 * Single source of truth for reading `VITE_*` network/passphrase/RPC env
 * vars. Previously these reads were duplicated (with subtly different
 * defaults and operator semantics) across `services/soroban.ts`,
 * `services/contractRegistry.ts`, `lib/config.ts`, governance pages, zap,
 * contacts, and analytics exports — this module consolidates them.
 *
 * Design notes:
 * - Injectable `env` parameter (default `import.meta.env`) follows the
 *   convention already established by `getApiBaseUrlState` in `lib/api.ts`
 *   so unit tests can pass a plain object instead of stubbing.
 * - Callers keep their historical default/operator semantics: transaction
 *   signing uses `??` + testnet defaults; diagnostics treats unset RPC /
 *   Horizon URLs as `null`; the contract registry treats an empty
 *   passphrase as `local`. Those divergences are intentional and are
 *   preserved here rather than "fixed", so migration is behavior-identical.
 * - Futurenet passphrases are recognized (`isFuturenet`) but still resolve
 *   to the registry id `testnet`, matching current behavior; adding
 *   `futurenet` to `SUPPORTED_NETWORKS` is an SDK-first change out of
 *   scope for this resolver.
 */

import type { ContractName, NetworkName } from "../services/contractRegistry";

export type EnvLike = ImportMetaEnv | Record<string, string | undefined>;

/** Default Soroban RPC used for transaction building/signing (testnet). */
export const DEFAULT_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

/** Default network passphrase used for transaction signing (testnet). */
export const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Effective passphrase shown by diagnostics when the env var is unset,
 * keyed by detected network. Values mirror the historical table in
 * `lib/config.ts` (including the `February 2017` local string, kept as-is
 * for backward compatibility with existing diagnostics output).
 */
export const EFFECTIVE_PASSPHRASES = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
  local: "Standalone Network ; February 2017",
} as const;

/** Exact `VITE_*` env var names for contract-id overrides (registry order). */
export const CONTRACT_ENV_KEYS = {
  vault: "VITE_CONTRACT_ID",
  zap: "VITE_ZAP_CONTRACT_ID",
  token: "VITE_TOKEN_CONTRACT_ID",
  governance: "VITE_GOVERNANCE_CONTRACT_ID",
  strategy: "VITE_STRATEGY_CONTRACT_ID",
  emissionController: "VITE_EMISSION_CONTROLLER_CONTRACT_ID",
  liquidStaking: "VITE_LIQUID_STAKING_CONTRACT_ID",
  stableswap: "VITE_STABLESWAP_CONTRACT_ID",
  vesting: "VITE_VESTING_CONTRACT_ID",
} as const satisfies Record<ContractName, string>;

/**
 * Map a network passphrase to the registry's network id.
 *
 * - mainnet / "Public Global" → `mainnet`
 * - empty / "local" / "standalone" → `local`
 * - anything else (testnet, futurenet, …) → `testnet`
 *
 * Futurenet maps to `testnet` deliberately: `SUPPORTED_NETWORKS` (client
 * and SDK) does not include `futurenet`, and registry.json has no
 * futurenet entry. Use {@link isFuturenetPassphrase} when the caller
 * needs to distinguish it.
 */
export function detectNetworkFromPassphrase(passphrase?: string): NetworkName {
  const pass = passphrase ?? "";
  if (pass.includes("mainnet") || pass.includes("Public Global")) {
    return "mainnet";
  }
  if (pass === "" || pass.includes("local") || pass.includes("standalone")) {
    return "local";
  }
  return "testnet";
}

/** True when the passphrase identifies Stellar Futurenet. */
export function isFuturenetPassphrase(passphrase?: string): boolean {
  const pass = (passphrase ?? "").toLowerCase();
  return pass.includes("future") || pass.includes("test sdf future");
}

/** Soroban RPC URL for transaction building (`??` + testnet default). */
export function getRpcUrl(env: EnvLike = import.meta.env): string {
  return env.VITE_SOROBAN_RPC_URL ?? DEFAULT_SOROBAN_RPC_URL;
}

/** Network passphrase for signing (`??` + testnet default). */
export function getNetworkPassphrase(env: EnvLike = import.meta.env): string {
  return env.VITE_NETWORK_PASSPHRASE ?? DEFAULT_NETWORK_PASSPHRASE;
}

/**
 * Detect the active network id from env.
 * Empty/`undefined` passphrase → `local` (registry semantics).
 */
export function detectNetwork(env: EnvLike = import.meta.env): NetworkName {
  return detectNetworkFromPassphrase(env.VITE_NETWORK_PASSPHRASE ?? "");
}

/** Horizon URL for diagnostics; `null` when unset (no default host). */
export function getHorizonUrl(env: EnvLike = import.meta.env): string | null {
  return env.VITE_HORIZON_URL || null;
}

/** Soroban RPC URL for diagnostics; `null` when unset (no default host). */
export function getDiagnosticRpcUrl(env: EnvLike = import.meta.env): string | null {
  return env.VITE_SOROBAN_RPC_URL || null;
}

/**
 * Effective passphrase for diagnostics: raw env when set, otherwise the
 * per-network default table ({@link EFFECTIVE_PASSPHRASES}).
 */
export function getEffectivePassphrase(env: EnvLike = import.meta.env): string {
  const passphrase = env.VITE_NETWORK_PASSPHRASE ?? "";
  if (passphrase) return passphrase;
  const activeNetwork = detectNetwork(env);
  return EFFECTIVE_PASSPHRASES[activeNetwork];
}

/** stellar.expert network path: binary `public` (mainnet) | `testnet`. */
export function getExplorerNetworkPath(env: EnvLike = import.meta.env): "public" | "testnet" {
  const passphrase = env.VITE_NETWORK_PASSPHRASE ?? "";
  const isMainnet = passphrase.includes("mainnet") || passphrase.includes("Public Global");
  return isMainnet ? "public" : "testnet";
}

/** stellar.expert account URL for the active network. */
export function explorerAccountUrl(
  address: string | null | undefined,
  env: EnvLike = import.meta.env,
): string {
  const base = `https://stellar.expert/explorer/${getExplorerNetworkPath(env)}`;
  return address ? `${base}/account/${address}` : base;
}

/**
 * Raw environment tag for export filenames:
 * `VITE_STELLAR_NETWORK` ?? `MODE` ?? `"production"`.
 * Callers apply filename sanitization (`sanitizeFilenameSegment`).
 */
export function getExportEnvironmentTag(env: EnvLike = import.meta.env): string {
  return (
    (env.VITE_STELLAR_NETWORK as string | undefined) ??
    (env.MODE as string | undefined) ??
    "production"
  );
}

/** Contract-id `VITE_*` overrides present in env (undefined values omitted). */
export function getContractEnvOverrides(
  env: EnvLike = import.meta.env,
): Partial<Record<ContractName, string>> {
  const overrides: Partial<Record<ContractName, string>> = {};
  (Object.keys(CONTRACT_ENV_KEYS) as ContractName[]).forEach((name) => {
    const value = env[CONTRACT_ENV_KEYS[name]];
    if (value !== undefined) {
      overrides[name] = value;
    }
  });
  return overrides;
}

export interface NetworkEnv {
  /** Registry network id: `testnet` | `mainnet` | `local`. */
  network: NetworkName;
  /** Raw passphrase for signing (`??` testnet default). */
  networkPassphrase: string;
  /** Raw RPC URL for signing (`??` testnet default). */
  rpcUrl: string;
  /** Diagnostics RPC URL (`|| null`). */
  diagnosticRpcUrl: string | null;
  /** Diagnostics Horizon URL (`|| null`). */
  horizonUrl: string | null;
  /** Diagnostics effective passphrase (env or per-network table). */
  effectivePassphrase: string;
  /** stellar.expert path: `public` | `testnet`. */
  explorerPath: "public" | "testnet";
  /** True when the passphrase identifies Stellar Futurenet. */
  isFuturenet: boolean;
  /** True when the detected network is mainnet. */
  isMainnet: boolean;
}

/** Resolve the full cross-network env view in one call. */
export function resolveNetworkEnv(env: EnvLike = import.meta.env): NetworkEnv {
  const networkPassphrase = getNetworkPassphrase(env);
  const network = detectNetwork(env);
  return {
    network,
    networkPassphrase,
    rpcUrl: getRpcUrl(env),
    diagnosticRpcUrl: getDiagnosticRpcUrl(env),
    horizonUrl: getHorizonUrl(env),
    effectivePassphrase: getEffectivePassphrase(env),
    explorerPath: getExplorerNetworkPath(env),
    isFuturenet: isFuturenetPassphrase(env.VITE_NETWORK_PASSPHRASE),
    isMainnet: network === "mainnet",
  };
}
