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
 *
 * Cache invalidation:
 * The registry maintains an in-memory cache with TTL and version tracking.
 * Cache is invalidated when:
 *   1. TTL expires
 *   2. Registry manifest changes (contract IDs differ)
 *   3. Manual refresh is requested
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import registryJson from "../../../contracts/registry.json";

export type ContractName =
  | "vault"
  | "zap"
  | "token"
  | "governance"
  | "strategy"
  | "emissionController"
  | "liquidStaking"
  | "stableswap"
  | "vesting";

export type NetworkName = "testnet" | "mainnet" | "local";

/** The only network ids this app knows how to resolve contract addresses for. */
export const SUPPORTED_NETWORKS: readonly NetworkName[] = ["testnet", "mainnet", "local"];

/**
 * Typed error raised when a network id falls outside {@link SUPPORTED_NETWORKS}
 * (#1109). Every flow that derives a network id (wallet connection via
 * `checkNetworkDiagnostics`, chart/registry status via
 * `checkRegistryDiagnostics`, and deposit/withdraw simulation's contract
 * lookups via `getContractId`) goes through {@link detectNetwork}, so
 * centralizing the check there gives all three the same typed failure
 * instead of each silently falling back to a default network.
 *
 * Same shape (`code`, `network`, `supportedNetworks`) as the SDK's
 * `UnsupportedNetworkError` (`packages/sdk/src/errors.ts`) so callers that
 * see either one can handle them the same way; kept as a separate class
 * here since the client does not depend on `@stellaryield/sdk` for pure
 * validation logic (the SDK dependency is a built package used only for
 * transaction lifecycle/signing).
 */
export class UnsupportedNetworkError extends Error {
  public readonly code = "unsupported_network" as const;
  public readonly network: string;
  public readonly supportedNetworks: readonly string[];

  constructor(network: string, supportedNetworks: readonly string[] = SUPPORTED_NETWORKS) {
    super(
      `Unsupported network id: '${network}'. Supported networks are: ${supportedNetworks.join(", ")}.`,
    );
    this.name = "UnsupportedNetworkError";
    this.network = network;
    this.supportedNetworks = supportedNetworks;
  }
}

export function isSupportedNetwork(network: string): network is NetworkName {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(network);
}

type Registry = Record<NetworkName, Record<ContractName, string>>;

const registry = registryJson as Registry;

export const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

interface RegistryCacheEntry {
  contractIds: Record<ContractName, string>;
  version: number;
  generatedAt: number;
  network: NetworkName;
  knownContractIds: Map<ContractName, string>;
}

let registryCache: RegistryCacheEntry | null = null;
let cacheVersionCounter = 0;
let lastInvalidatedAt = Date.now();

export function detectNetwork(): NetworkName {
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
  vesting: import.meta.env.VITE_VESTING_CONTRACT_ID,
};

function isCacheValid(entry: RegistryCacheEntry, network: NetworkName): boolean {
  const age = Date.now() - entry.generatedAt;
  if (age > REGISTRY_CACHE_TTL_MS) {
    return false;
  }

  if (entry.network !== network) {
    return false;
  }

  const contractNames: ContractName[] = [
    "vault", "zap", "token", "governance", "strategy",
    "emissionController", "liquidStaking", "stableswap", "vesting",
  ];

  for (const name of contractNames) {
    const envOverride = ENV_OVERRIDES[name];
    const currentId = envOverride || registry[network]?.[name] || "";
    const cachedId = entry.knownContractIds.get(name);

    if (cachedId !== currentId) {
      return false;
    }
  }

  return true;
}

function buildCacheEntry(network: NetworkName): RegistryCacheEntry {
  const contractNames: ContractName[] = [
    "vault", "zap", "token", "governance", "strategy",
    "emissionController", "liquidStaking", "stableswap", "vesting",
  ];

  const contractIds: Record<ContractName, string> = {} as Record<ContractName, string>;
  const knownContractIds = new Map<ContractName, string>();

  for (const name of contractNames) {
    const envOverride = ENV_OVERRIDES[name];
    const id = envOverride || registry[network]?.[name] || "";
    contractIds[name] = id;
    knownContractIds.set(name, id);
  }

  cacheVersionCounter += 1;
  lastInvalidatedAt = Date.now();

  return {
    contractIds,
    version: cacheVersionCounter,
    generatedAt: Date.now(),
    network,
    knownContractIds,
  };
}

export function invalidateContractRegistryCache(): void {
  registryCache = null;
  cacheVersionCounter += 1;
  lastInvalidatedAt = Date.now();
}

export function refreshContractRegistryCache(network?: NetworkName): void {
  const net = network ?? detectNetwork();
  registryCache = buildCacheEntry(net);
}

export function getContractRegistryCacheInfo(): {
  cacheAge: number;
  cacheVersion: number;
  lastInvalidatedAt: string;
  isCached: boolean;
} {
  if (!registryCache) {
    return {
      cacheAge: -1,
      cacheVersion: cacheVersionCounter,
      lastInvalidatedAt: new Date(lastInvalidatedAt).toISOString(),
      isCached: false,
    };
  }

  return {
    cacheAge: Date.now() - registryCache.generatedAt,
    cacheVersion: registryCache.version,
    lastInvalidatedAt: new Date(lastInvalidatedAt).toISOString(),
    isCached: true,
  };
}

/**
 * Validates an explicitly-provided network id against {@link SUPPORTED_NETWORKS}
 * (#1109). `network` is typed as `NetworkName` for callers within this
 * codebase, but wallet/chart/simulation flows can also receive a network id
 * from outside the type system (a wallet adapter callback, a query param, a
 * value cast through `as`), so every entry point that accepts an explicit
 * `network` re-validates it at runtime rather than trusting the type.
 * Throws {@link UnsupportedNetworkError} before any contract lookup happens.
 */
function assertSupportedNetwork(network: NetworkName): void {
  if (!isSupportedNetwork(network)) {
    throw new UnsupportedNetworkError(network);
  }
}

export function getContractId(
  name: ContractName,
  network?: NetworkName,
): string {
  const envOverride = ENV_OVERRIDES[name];
  if (envOverride) return envOverride;

  const net = network ?? detectNetwork();
  assertSupportedNetwork(net);

  if (registryCache && isCacheValid(registryCache, net)) {
    return registryCache.contractIds[name] ?? "";
  }

  registryCache = buildCacheEntry(net);
  return registryCache.contractIds[name] ?? "";
}

export function getAllContractIds(network?: NetworkName): Record<ContractName, string> {
  const net = network ?? detectNetwork();
  assertSupportedNetwork(net);

  if (registryCache && isCacheValid(registryCache, net)) {
    return { ...registryCache.contractIds };
  }

  registryCache = buildCacheEntry(net);
  return { ...registryCache.contractIds };
}

export function validateContractRegistryEntry(
  name: string,
  contractId: string,
  network?: NetworkName,
): void {
  const activeNetwork = network ?? detectNetwork();
  assertSupportedNetwork(activeNetwork);

  const supportedNames: string[] = [
    "vault",
    "zap",
    "token",
    "governance",
    "strategy",
    "emissionController",
    "liquidStaking",
    "stableswap",
    "vesting",
  ];

  if (!supportedNames.includes(name)) {
    throw new Error(
      `Unsupported contract name: "${name}". Valid contracts are: ${supportedNames.join(", ")}.`
    );
  }

  if (!contractId || contractId.trim() === "") {
    throw new Error(
      `Missing contract ID for "${name}". Please configure it via environment variables (e.g. VITE_${name.toUpperCase()}_CONTRACT_ID or VITE_CONTRACT_ID for vault) or update contracts/registry.json.`
    );
  }

  try {
    new StellarSdk.Address(contractId);
    if (contractId.length !== 56 || !contractId.startsWith("C")) {
      throw new Error(
        `Invalid contract ID format for "${name}": "${contractId}". Soroban contract IDs must start with 'C' and be 56 characters long.`
      );
    }
  } catch (err) {
    throw new Error(
      `Invalid contract ID format for "${name}": "${contractId}". Soroban contract IDs must be valid Stellar contract addresses starting with 'C' and 56 characters long. Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const networks: NetworkName[] = ["testnet", "mainnet", "local"];
  let registeredOnDifferentNetwork: NetworkName | null = null;
  for (const net of networks) {
    if (net !== activeNetwork) {
      const regValue = (registryJson as any)[net]?.[name];
      if (regValue && regValue === contractId) {
        registeredOnDifferentNetwork = net;
        break;
      }
    }
  }

  if (registeredOnDifferentNetwork) {
    throw new Error(
      `Network mismatch: Contract "${name}" has ID "${contractId}" which is registered for "${registeredOnDifferentNetwork}", but active network is "${activeNetwork}".`
    );
  }

  for (const otherName of supportedNames) {
    if (otherName !== name) {
      const activeVal = getContractId(otherName as ContractName, activeNetwork);
      if (activeVal && activeVal === contractId) {
        throw new Error(
          `Contract name mismatch: Provided ID "${contractId}" for "${name}" actually matches the configured address for contract "${otherName}" on network "${activeNetwork}".`
        );
      }
    }
  }
}

