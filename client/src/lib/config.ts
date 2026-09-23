/**
 * System configuration and dependency diagnostics module (#1037).
 *
 * Evaluates environment configuration, API base URL validity, wallet availability,
 * active network, and Soroban contract registry status.
 *
 * Designed to provide clear, actionable diagnostics in preview/production deployments
 * without exposing secrets or sensitive credentials.
 */

import { getApiBaseUrlState } from "./api";
import {
  detectNetwork,
  getAllContractIds,
  validateContractRegistryEntry,
  type ContractName,
  type NetworkName,
} from "../services/contractRegistry";

export type DependencyStatus = "healthy" | "warning" | "error" | "unconfigured";

export interface ApiDiagnostics {
  status: DependencyStatus;
  baseUrl: string;
  isConfigured: boolean;
  isLocalFallback: boolean;
  isValidFormat: boolean;
  hint: string;
  maskedUrl: string;
}

export interface WalletDiagnostics {
  status: DependencyStatus;
  isFreighterAvailable: boolean;
  isAlbedoAvailable: boolean;
  isXBullAvailable: boolean;
  isConnected: boolean;
  provider: string | null;
  walletAddress: string | null;
  maskedAddress: string | null;
  hint: string;
}

export interface NetworkDiagnostics {
  status: DependencyStatus;
  activeNetwork: NetworkName;
  passphrase: string;
  rpcUrl: string | null;
  horizonUrl: string | null;
  hint: string;
}

export interface ContractItemStatus {
  name: ContractName;
  contractId: string;
  source: "env" | "registry" | "missing";
  isValidFormat: boolean;
  maskedId: string;
}

export interface RegistryDiagnostics {
  status: DependencyStatus;
  totalContracts: number;
  configuredContracts: number;
  missingContracts: ContractName[];
  invalidContracts: ContractName[];
  contracts: ContractItemStatus[];
  hint: string;
}

export interface SystemDiagnostics {
  overallStatus: DependencyStatus;
  timestamp: string;
  api: ApiDiagnostics;
  wallet: WalletDiagnostics;
  network: NetworkDiagnostics;
  registry: RegistryDiagnostics;
}

/**
 * Mask sensitive query parameters, passwords, or authentication keys in URLs.
 */
export function maskUrl(url: string): string {
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    const searchParams = new URLSearchParams(parsed.search);
    for (const key of Array.from(searchParams.keys())) {
      if (/key|secret|token|auth|pass|cred|api_key/i.test(key)) {
        searchParams.set(key, "******");
      }
    }
    parsed.search = searchParams.toString();
    if (parsed.password) {
      parsed.password = "******";
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&](?:key|secret|token|auth|pass|cred|api_key)=)[^&]+/gi, "$1******");
  }
}

/**
 * Mask public keys/addresses to prevent accidental log leaks while remaining identifiable.
 */
export function maskAddress(address: string | null | undefined): string | null {
  if (!address || typeof address !== "string" || address.trim() === "") return null;
  const trimmed = address.trim();
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Inspect API configuration and determine health and actionable hints.
 */
export function checkApiDiagnostics(env: ImportMetaEnv = import.meta.env): ApiDiagnostics {
  const configuredValue = env.VITE_API_BASE_URL || env.VITE_API_URL;
  const state = getApiBaseUrlState(env);

  const isExplicitlyConfigured =
    configuredValue !== undefined && configuredValue !== null && configuredValue.trim() !== "";

  if (!state.available) {
    const isMalformed = state.reason.startsWith("Invalid API URL configuration");
    return {
      status: isMalformed ? "error" : "unconfigured",
      baseUrl: isExplicitlyConfigured ? configuredValue.trim() : "",
      isConfigured: isExplicitlyConfigured,
      isLocalFallback: false,
      isValidFormat: !isMalformed,
      hint: isMalformed
        ? state.reason
        : "VITE_API_BASE_URL is not set. In preview or production deployments, configure VITE_API_BASE_URL to point to your backend service.",
      maskedUrl: maskUrl(isExplicitlyConfigured ? configuredValue.trim() : ""),
    };
  }

  const isLocalFallback =
    !isExplicitlyConfigured && state.baseUrl.includes("localhost");

  return {
    status: isLocalFallback ? "warning" : "healthy",
    baseUrl: state.baseUrl,
    isConfigured: isExplicitlyConfigured,
    isLocalFallback,
    isValidFormat: true,
    hint: isLocalFallback
      ? "Using default local backend (http://localhost:3001). Set VITE_API_BASE_URL if connecting to a remote API."
      : "Backend API base URL is configured and valid.",
    maskedUrl: maskUrl(state.baseUrl),
  };
}

/**
 * Inspect client wallet availability (Freighter, Albedo, xBull).
 */
export function checkWalletDiagnostics(
  connectedSession?: { isConnected: boolean; address: string | null; provider?: string | null } | null,
): WalletDiagnostics {
  const isBrowser = typeof window !== "undefined";

  const isFreighterAvailable =
    isBrowser &&
    Boolean(
      (window as unknown as { freighter?: unknown }).freighter ||
      (window as unknown as { stellar?: { freighter?: unknown } }).stellar?.freighter
    );

  const isAlbedoAvailable =
    isBrowser && Boolean((window as unknown as { albedo?: unknown }).albedo);

  const isXBullAvailable =
    isBrowser && Boolean((window as unknown as { xBull?: unknown }).xBull);

  const isConnected = Boolean(connectedSession?.isConnected && connectedSession.address);
  const address = isConnected ? connectedSession?.address ?? null : null;
  const provider = isConnected ? connectedSession?.provider ?? "Freighter" : null;

  let status: DependencyStatus = "unconfigured";
  let hint = "No Stellar wallet extension detected. Install Freighter, Albedo, or xBull to interact with on-chain vaults.";

  if (isConnected) {
    status = "healthy";
    hint = `Connected to ${provider || "Wallet"} with address ${maskAddress(address)}.`;
  } else if (isFreighterAvailable || isAlbedoAvailable || isXBullAvailable) {
    status = "warning";
    const availableList = [
      isFreighterAvailable ? "Freighter" : null,
      isAlbedoAvailable ? "Albedo" : null,
      isXBullAvailable ? "xBull" : null,
    ]
      .filter(Boolean)
      .join(", ");
    hint = `Wallet extension detected (${availableList}). Connect your wallet to view balances and sign transactions.`;
  }

  return {
    status,
    isFreighterAvailable,
    isAlbedoAvailable,
    isXBullAvailable,
    isConnected,
    provider,
    walletAddress: address,
    maskedAddress: maskAddress(address),
    hint,
  };
}

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

/**
 * Inspect active Stellar network configuration.
 */
export function checkNetworkDiagnostics(env: ImportMetaEnv = import.meta.env): NetworkDiagnostics {
  const passphrase = env.VITE_NETWORK_PASSPHRASE ?? "";
  const activeNetwork = passphrase ? detectNetworkFromPassphrase(passphrase) : detectNetwork();
  const effectivePassphrase =
    passphrase ||
    (activeNetwork === "mainnet"
      ? "Public Global Stellar Network ; September 2015"
      : activeNetwork === "local"
      ? "Standalone Network ; February 2017"
      : "Test SDF Network ; September 2015");

  const rpcUrl = env.VITE_SOROBAN_RPC_URL || null;
  const horizonUrl = env.VITE_HORIZON_URL || null;

  let status: DependencyStatus = "healthy";
  let hint = `Active network: ${activeNetwork.toUpperCase()}.`;

  if (activeNetwork === "local") {
    status = "warning";
    hint = "Targeting local standalone network. Ensure a local Stellar/Soroban node is running on localhost.";
  } else if (activeNetwork === "testnet") {
    hint = "Targeting Stellar Testnet for testing. On-chain tokens have no real-world value.";
  }

  return {
    status,
    activeNetwork,
    passphrase: effectivePassphrase,
    rpcUrl: rpcUrl ? maskUrl(rpcUrl) : null,
    horizonUrl: horizonUrl ? maskUrl(horizonUrl) : null,
    hint,
  };
}

/**
 * Inspect Soroban contract registry status for the active network.
 */
export function checkRegistryDiagnostics(
  network?: NetworkName,
): RegistryDiagnostics {
  const activeNetwork = network ?? detectNetwork();
  const allContracts = getAllContractIds(activeNetwork);

  const contractNames: ContractName[] = [
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

  const contracts: ContractItemStatus[] = [];
  const missingContracts: ContractName[] = [];
  const invalidContracts: ContractName[] = [];

  for (const name of contractNames) {
    const contractId = allContracts[name] || "";
    let isValidFormat = false;

    if (contractId && contractId.trim() !== "") {
      try {
        validateContractRegistryEntry(name, contractId, activeNetwork);
        isValidFormat = true;
      } catch {
        isValidFormat = false;
        invalidContracts.push(name);
      }
    } else {
      missingContracts.push(name);
    }

    const envKey = name === "vault" ? "VITE_CONTRACT_ID" : `VITE_${name.toUpperCase()}_CONTRACT_ID`;
    const hasEnvOverride = Boolean(import.meta.env[envKey]);

    contracts.push({
      name,
      contractId,
      source: !contractId ? "missing" : hasEnvOverride ? "env" : "registry",
      isValidFormat,
      maskedId: maskAddress(contractId) || "Not configured",
    });
  }

  const totalContracts = contractNames.length;
  const configuredContracts = totalContracts - missingContracts.length;

  let status: DependencyStatus = "healthy";
  let hint = `All ${totalContracts} contract addresses are loaded and valid for ${activeNetwork}.`;

  if (missingContracts.includes("vault") || missingContracts.includes("token")) {
    status = "error";
    hint = `Critical contract missing: ${missingContracts.filter((c) => c === "vault" || c === "token").join(", ")}. Provide VITE_CONTRACT_ID or update contracts/registry.json.`;
  } else if (missingContracts.length > 0 || invalidContracts.length > 0) {
    status = "warning";
    hint = `${configuredContracts}/${totalContracts} contracts configured for ${activeNetwork}. Missing: ${missingContracts.join(", ") || "none"}.`;
  }

  return {
    status,
    totalContracts,
    configuredContracts,
    missingContracts,
    invalidContracts,
    contracts,
    hint,
  };
}

/**
 * Evaluates full system diagnostics across API, Wallet, Network, and Registry.
 */
export function getSystemDiagnostics(
  env: ImportMetaEnv = import.meta.env,
  walletContext?: { isConnected: boolean; address: string | null; provider?: string | null } | null,
): SystemDiagnostics {
  const api = checkApiDiagnostics(env);
  const wallet = checkWalletDiagnostics(walletContext);
  const network = checkNetworkDiagnostics(env);
  const registry = checkRegistryDiagnostics(network.activeNetwork);

  let overallStatus: DependencyStatus = "healthy";

  if (api.status === "error" || registry.status === "error") {
    overallStatus = "error";
  } else if (
    api.status === "warning" ||
    api.status === "unconfigured" ||
    registry.status === "warning" ||
    wallet.status === "unconfigured" ||
    network.status === "warning"
  ) {
    overallStatus = "warning";
  }

  return {
    overallStatus,
    timestamp: new Date().toISOString(),
    api,
    wallet,
    network,
    registry,
  };
}

// ── Global Custom Event Dispatcher for Diagnostics Modal ─────────────────

const OPEN_DIAGNOSTICS_EVENT = "stellar-yield:open-diagnostics";

export function openDiagnosticsPanel(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_DIAGNOSTICS_EVENT));
  }
}

export function listenToOpenDiagnostics(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback();
  window.addEventListener(OPEN_DIAGNOSTICS_EVENT, handler);
  return () => window.removeEventListener(OPEN_DIAGNOSTICS_EVENT, handler);
}
