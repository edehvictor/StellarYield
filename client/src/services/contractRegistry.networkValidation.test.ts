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
      vault: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      zap: "",
      token: "",
      governance: "",
      strategy: "",
      emissionController: "",
      liquidStaking: "",
      stableswap: "",
      vesting: "",
    },
    mainnet: {
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
  getContractId,
  getAllContractIds,
  validateContractRegistryEntry,
  invalidateContractRegistryCache,
  isSupportedNetwork,
  UnsupportedNetworkError,
  SUPPORTED_NETWORKS,
  type NetworkName,
} from "./contractRegistry";

/**
 * Tests for centralized network id validation (#1109).
 *
 * These live in a dedicated file rather than `contractRegistry.test.ts`
 * because that file currently has pre-existing duplicate `const`
 * declarations (a syntax error) unrelated to this change; see the fix's
 * scoping notes.
 */
describe("contractRegistry network id validation", () => {
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

  describe("SUPPORTED_NETWORKS / isSupportedNetwork", () => {
    it("supports exactly testnet, mainnet, local", () => {
      expect([...SUPPORTED_NETWORKS].sort()).toEqual(["local", "mainnet", "testnet"]);
    });

    it("isSupportedNetwork accepts known networks and rejects unknown ones", () => {
      expect(isSupportedNetwork("testnet")).toBe(true);
      expect(isSupportedNetwork("mainnet")).toBe(true);
      expect(isSupportedNetwork("local")).toBe(true);
      expect(isSupportedNetwork("futurenet")).toBe(false);
      expect(isSupportedNetwork("")).toBe(false);
    });
  });

  describe("getContractId", () => {
    it("throws UnsupportedNetworkError for an unrecognized explicit network id", () => {
      expect(() => getContractId("vault", "futurenet" as NetworkName)).toThrow(
        UnsupportedNetworkError,
      );
    });

    it("does not throw for supported networks", () => {
      expect(() => getContractId("vault", "testnet")).not.toThrow();
      expect(() => getContractId("vault", "mainnet")).not.toThrow();
      expect(() => getContractId("vault", "local")).not.toThrow();
    });

    it("error carries the offending network id and the supported list", () => {
      try {
        getContractId("vault", "futurenet" as NetworkName);
        throw new Error("expected getContractId to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedNetworkError);
        const typed = err as UnsupportedNetworkError;
        expect(typed.code).toBe("unsupported_network");
        expect(typed.network).toBe("futurenet");
        expect(typed.supportedNetworks).toEqual(SUPPORTED_NETWORKS);
      }
    });
  });

  describe("getAllContractIds", () => {
    it("throws UnsupportedNetworkError for an unrecognized explicit network id", () => {
      expect(() => getAllContractIds("futurenet" as NetworkName)).toThrow(UnsupportedNetworkError);
    });

    it("returns a full contract map for a supported network", () => {
      const ids = getAllContractIds("testnet");
      expect(ids).toHaveProperty("vault");
      expect(ids).toHaveProperty("zap");
    });
  });

  describe("validateContractRegistryEntry", () => {
    it("throws UnsupportedNetworkError before any contract-id validation for an unrecognized network", () => {
      expect(() =>
        validateContractRegistryEntry(
          "vault",
          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
          "futurenet" as NetworkName,
        ),
      ).toThrow(UnsupportedNetworkError);
    });

    it("does not throw the unsupported-network error for a supported network", () => {
      expect(() =>
        validateContractRegistryEntry(
          "vault",
          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
          "testnet",
        ),
      ).not.toThrow(UnsupportedNetworkError);
    });
  });
});
