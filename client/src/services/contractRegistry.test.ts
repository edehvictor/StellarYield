import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@stellar/stellar-sdk", () => ({
  Address: vi.fn().mockImplementation((address: string) => {
    if (!address || typeof address !== "string") {
      throw new Error("Invalid address");
    }
    if (address.length !== 56) {
      throw new Error("Invalid address length");
    }
    if (!address.startsWith("C") && !address.startsWith("G")) {
      throw new Error("Invalid address prefix");
    }
    return { address };
  }),
}));

vi.mock("../../../contracts/registry.json", () => ({
  default: {
    testnet: {
      vault: "CDBA5T47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U",
      zap: "CDZAP47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0UX",
      vault: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", // 56 chars valid contract ID
      zap: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      token: "",
      governance: "",
      strategy: "",
      emissionController: "",
      liquidStaking: "",
      stableswap: "",
      vesting: "",
    },
    mainnet: {
      vault: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
      zap: "",
      token: "",
      governance: "",
      strategy: "",
      emissionController: "",
      liquidStaking: "",
      stableswap: "",
      vesting: "",
    },
    local: {
      vault: "",
      zap: "",
      token: "",
      governance: "",
      strategy: "",
      emissionController: "",
      liquidStaking: "",
      stableswap: "",
      vesting: "",
    },
  },
}));

import {
  detectNetwork,
  getContractId,
  getAllContractIds,
  validateContractRegistryEntry,
  invalidateContractRegistryCache,
  refreshContractRegistryCache,
  getContractRegistryCacheInfo,
  REGISTRY_CACHE_TTL_MS,
} from "./contractRegistry";

describe("Contract Registry Validation", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
    vi.stubEnv("VITE_CONTRACT_ID", "");
    vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
    vi.stubEnv("VITE_VESTING_CONTRACT_ID", "");
    invalidateContractRegistryCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects active network correctly from passphrase", () => {
    expect(detectNetwork()).toBe("testnet");

    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Public Global Stellar Network ; November 2015");
    expect(detectNetwork()).toBe("mainnet");

    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "local standalone network");
    expect(detectNetwork()).toBe("local");
  });

  it("validates correct contract registry entry", () => {
    const validId = "CDBA5T47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U";
    const validId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    // Should not throw
    expect(() => validateContractRegistryEntry("vault", validId)).not.toThrow();
  });

  it("throws error for unsupported contract name", () => {
    expect(() =>
      validateContractRegistryEntry("invalid_name", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4")
    ).toThrow(/Unsupported contract name/);
  });

  it("throws error for missing or empty contract ID", () => {
    expect(() => validateContractRegistryEntry("vault", "")).toThrow(/Missing contract ID/);
    expect(() => validateContractRegistryEntry("vault", "   ")).toThrow(/Missing contract ID/);
  });

  it("throws error for invalid contract ID format", () => {
    expect(() => validateContractRegistryEntry("vault", "CD123")).toThrow(/Invalid contract ID format/);
    const gAddress = "GDBA5T47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U";
    // Doesn't start with C (starts with G, which is a public key address, not a contract ID)
    const gAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    expect(() => validateContractRegistryEntry("vault", gAddress)).toThrow(/Invalid contract ID format/);
  });

  it("throws error for network passphrase/contract mismatch", () => {
    const mainnetVaultId = "CDMAIN57Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U";
    // Mainnet contract ID
    const mainnetVaultId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
    
    expect(() =>
      validateContractRegistryEntry("vault", mainnetVaultId, "testnet")
    ).toThrow(/Network mismatch: Contract "vault" has ID ".*" which is registered for "mainnet", but active network is "testnet"/);
  });

  it("throws error for contract name mismatch", () => {
    const zapId = "CDZAP47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0UX";
    // Zap contract ID on testnet
    const zapId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    expect(() =>
      validateContractRegistryEntry("vault", zapId, "testnet")
    ).toThrow(/Contract name mismatch/);
  });
});

describe("Contract Registry Cache Invalidation", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
    vi.stubEnv("VITE_CONTRACT_ID", "");
    vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
    vi.stubEnv("VITE_VESTING_CONTRACT_ID", "");
    invalidateContractRegistryCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns cache info showing not cached initially", () => {
    const info = getContractRegistryCacheInfo();
    expect(info.isCached).toBe(false);
    expect(info.cacheAge).toBe(-1);
  });

  it("caches contract IDs after first access", () => {
    getContractId("vault", "testnet");
    
    const info = getContractRegistryCacheInfo();
    expect(info.isCached).toBe(true);
    expect(info.cacheVersion).toBeGreaterThan(0);
    expect(info.cacheAge).toBeGreaterThanOrEqual(0);
  });

  it("serves cached data on subsequent calls", () => {
    const firstCall = getContractId("vault", "testnet");
    const infoAfterFirst = getContractRegistryCacheInfo();
    
    const secondCall = getContractId("vault", "testnet");
    const infoAfterSecond = getContractRegistryCacheInfo();
    
    expect(firstCall).toBe(secondCall);
    expect(infoAfterFirst.cacheVersion).toBe(infoAfterSecond.cacheVersion);
  });

  it("invalidates cache when invalidateContractRegistryCache is called", () => {
    getContractId("vault", "testnet");
    expect(getContractRegistryCacheInfo().isCached).toBe(true);
    
    invalidateContractRegistryCache();
    
    const info = getContractRegistryCacheInfo();
    expect(info.isCached).toBe(false);
  });

  it("rebuilds cache after invalidation on next access", () => {
    getContractId("vault", "testnet");
    const versionBefore = getContractRegistryCacheInfo().cacheVersion;
    
    invalidateContractRegistryCache();
    getContractId("vault", "testnet");
    
    const versionAfter = getContractRegistryCacheInfo().cacheVersion;
    expect(versionAfter).toBeGreaterThan(versionBefore);
  });

  it("invalidates cache when TTL expires", () => {
    getContractId("vault", "testnet");
    expect(getContractRegistryCacheInfo().isCached).toBe(true);
    
    vi.advanceTimersByTime(REGISTRY_CACHE_TTL_MS + 1000);
    
    const info = getContractRegistryCacheInfo();
    expect(info.cacheAge).toBeGreaterThan(REGISTRY_CACHE_TTL_MS);
  });

  it("rebuilds cache when accessing after TTL expiry", () => {
    getContractId("vault", "testnet");
    const versionBefore = getContractRegistryCacheInfo().cacheVersion;
    
    vi.advanceTimersByTime(REGISTRY_CACHE_TTL_MS + 1000);
    getContractId("vault", "testnet");
    
    const versionAfter = getContractRegistryCacheInfo().cacheVersion;
    expect(versionAfter).toBeGreaterThan(versionBefore);
  });

  it("invalidates cache when network changes", () => {
    getContractId("vault", "testnet");
    const versionBefore = getContractRegistryCacheInfo().cacheVersion;
    
    getContractId("vault", "mainnet");
    
    const versionAfter = getContractRegistryCacheInfo().cacheVersion;
    expect(versionAfter).toBeGreaterThan(versionBefore);
  });

  it("refreshContractRegistryCache forces cache rebuild", () => {
    getContractId("vault", "testnet");
    const versionBefore = getContractRegistryCacheInfo().cacheVersion;
    
    refreshContractRegistryCache("testnet");
    
    const versionAfter = getContractRegistryCacheInfo().cacheVersion;
    expect(versionAfter).toBeGreaterThan(versionBefore);
  });

  it("getAllContractIds uses cache", () => {
    const firstCall = getAllContractIds("testnet");
    const versionBefore = getContractRegistryCacheInfo().cacheVersion;
    
    const secondCall = getAllContractIds("testnet");
    const versionAfter = getContractRegistryCacheInfo().cacheVersion;
    
    expect(firstCall).toEqual(secondCall);
    expect(versionBefore).toBe(versionAfter);
  });

  it("getAllContractIds returns fresh copy of cached data", () => {
    const firstCall = getAllContractIds("testnet");
    const secondCall = getAllContractIds("testnet");
    
    expect(firstCall).not.toBe(secondCall);
    expect(firstCall).toEqual(secondCall);
  });

  it("detects stale manifest when contract ID changes via env override", () => {
    getContractId("vault", "testnet");
    const versionBefore = getContractRegistryCacheInfo().cacheVersion;
    
    vi.stubEnv("VITE_CONTRACT_ID", "CDBA5T47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U");
    
    const newId = getContractId("vault", "testnet");
    expect(newId).toBe("CDBA5T47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U");
  });

  it("cache invalidation updates lastInvalidatedAt timestamp", () => {
    const initialTime = Date.now();
    getContractId("vault", "testnet");
    
    vi.advanceTimersByTime(10000);
    invalidateContractRegistryCache();
    
    const info = getContractRegistryCacheInfo();
    const invalidatedTime = new Date(info.lastInvalidatedAt).getTime();
    expect(invalidatedTime).toBeGreaterThan(initialTime);
  });
});

describe("Contract Registry Partial Fetch Failure", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
    vi.stubEnv("VITE_CONTRACT_ID", "");
    vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
    vi.stubEnv("VITE_VESTING_CONTRACT_ID", "");
    invalidateContractRegistryCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty string for missing contract IDs", () => {
    const tokenId = getContractId("token", "testnet");
    expect(tokenId).toBe("");
  });

  it("getAllContractIds includes empty strings for missing contracts", () => {
    const allIds = getAllContractIds("testnet");
    
    expect(allIds.vault).toBe("CDBA5T47Q4U5BOHH2T2K3V4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U");
    expect(allIds.token).toBe("");
    expect(allIds.governance).toBe("");
  });

  it("handles local network with all empty contract IDs", () => {
    const allIds = getAllContractIds("local");
    
    expect(allIds.vault).toBe("");
    expect(allIds.zap).toBe("");
    expect(allIds.token).toBe("");
  });

  it("partial registry does not break cache", () => {
    getContractId("token", "testnet");
    const info = getContractRegistryCacheInfo();
    
    expect(info.isCached).toBe(true);
    expect(info.cacheVersion).toBeGreaterThan(0);
  });

  it("cache works correctly with mixed present and missing contracts", () => {
    const firstVault = getContractId("vault", "testnet");
    const firstToken = getContractId("token", "testnet");
    
    const versionBefore = getContractRegistryCacheInfo().cacheVersion;
    
    const secondVault = getContractId("vault", "testnet");
    const secondToken = getContractId("token", "testnet");
    
    const versionAfter = getContractRegistryCacheInfo().cacheVersion;
    
    expect(firstVault).toBe(secondVault);
    expect(firstToken).toBe(secondToken);
    expect(versionBefore).toBe(versionAfter);
  });
});
