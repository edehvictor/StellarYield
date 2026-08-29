import { describe, it, expect, vi, beforeEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

// Mock the registry JSON file
vi.mock("../../../contracts/registry.json", () => ({
  default: {
    testnet: {
      vault: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
      zap: "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
      token: "",
      governance: "",
      strategy: "",
      emissionController: "",
      liquidStaking: "",
      stableswap: "",
      vesting: "",
    },
    mainnet: {
      vault: "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3",
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
  validateContractRegistryEntry,
} from "./contractRegistry";

describe("Contract Registry Validation", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
    vi.stubEnv("VITE_CONTRACT_ID", "");
    vi.stubEnv("VITE_ZAP_CONTRACT_ID", "");
    vi.stubEnv("VITE_VESTING_CONTRACT_ID", "");
  });

  it("detects active network correctly from passphrase", () => {
    expect(detectNetwork()).toBe("testnet");

    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Public Global Stellar Network ; November 2015");
    expect(detectNetwork()).toBe("mainnet");

    vi.stubEnv("VITE_NETWORK_PASSPHRASE", "local standalone network");
    expect(detectNetwork()).toBe("local");
  });

  it("validates correct contract registry entry", () => {
    const validId = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
    // Should not throw
    expect(() => validateContractRegistryEntry("vault", validId)).not.toThrow();
  });

  it("throws error for unsupported contract name", () => {
    expect(() =>
      validateContractRegistryEntry("invalid_name", "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526")
    ).toThrow(/Unsupported contract name/);
  });

  it("throws error for missing or empty contract ID", () => {
    expect(() => validateContractRegistryEntry("vault", "")).toThrow(/Missing contract ID/);
    expect(() => validateContractRegistryEntry("vault", "   ")).toThrow(/Missing contract ID/);
  });

  it("throws error for invalid contract ID format", () => {
    // Too short
    expect(() => validateContractRegistryEntry("vault", "CD123")).toThrow(/Invalid contract ID format/);
    // Doesn't start with C (starts with G, which is a public key address, not a contract ID)
    const gAddress = "GAYOAUGI465BOMRPHU233EHR2C7Q6X3TGVH3D4U3N7RPA73GZ3A2T3W2";
    expect(() => validateContractRegistryEntry("vault", gAddress)).toThrow(/Invalid contract ID format/);
  });

  it("throws error for network passphrase/contract mismatch", () => {
    // Mainnet contract ID
    const mainnetVaultId = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
    
    // We are on testnet, so validating this ID for "vault" should throw network mismatch
    expect(() =>
      validateContractRegistryEntry("vault", mainnetVaultId, "testnet")
    ).toThrow(/Network mismatch: Contract "vault" has ID ".*" which is registered for "mainnet", but active network is "testnet"/);
  });

  it("throws error for contract name mismatch", () => {
    // Zap contract ID on testnet
    const zapId = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";

    // Providing the Zap contract ID as the "vault" contract ID should fail
    expect(() =>
      validateContractRegistryEntry("vault", zapId, "testnet")
    ).toThrow(/Contract name mismatch/);
  });
});
