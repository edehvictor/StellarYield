/**
 * Tests for centralized network id validation (#1109).
 *
 * Covers:
 *   - isSupportedNetwork / validateNetworkName accept all supported networks
 *   - validateNetworkName rejects unknown, empty, and mismatched-case ids
 *   - UnsupportedNetworkError carries the offending network + supported list
 *   - ContractRegistryLoader.resolve/resolveAll/requireContractId reject an
 *     unsupported network before doing any lookup
 */

import { describe, it, expect } from "vitest";
import { isSupportedNetwork, validateNetworkName, SUPPORTED_NETWORKS } from "../src/network";
import { UnsupportedNetworkError } from "../src/errors";
import { createContractRegistryLoader, type ContractRegistry } from "../src/contractRegistry";

describe("SUPPORTED_NETWORKS", () => {
  it("is exactly testnet, mainnet, local", () => {
    expect([...SUPPORTED_NETWORKS].sort()).toEqual(["local", "mainnet", "testnet"]);
  });
});

describe("isSupportedNetwork", () => {
  it("returns true for each supported network", () => {
    expect(isSupportedNetwork("testnet")).toBe(true);
    expect(isSupportedNetwork("mainnet")).toBe(true);
    expect(isSupportedNetwork("local")).toBe(true);
  });

  it("returns false for an unknown network id", () => {
    expect(isSupportedNetwork("futurenet")).toBe(false);
    expect(isSupportedNetwork("devnet")).toBe(false);
    expect(isSupportedNetwork("")).toBe(false);
  });

  it("is case-sensitive (mismatched case is not supported)", () => {
    expect(isSupportedNetwork("Testnet")).toBe(false);
    expect(isSupportedNetwork("MAINNET")).toBe(false);
  });
});

describe("validateNetworkName", () => {
  it("returns the network id unchanged when supported", () => {
    expect(validateNetworkName("testnet")).toBe("testnet");
    expect(validateNetworkName("mainnet")).toBe("mainnet");
    expect(validateNetworkName("local")).toBe("local");
  });

  it("throws UnsupportedNetworkError for an unknown network id", () => {
    expect(() => validateNetworkName("futurenet")).toThrow(UnsupportedNetworkError);
  });

  it("throws UnsupportedNetworkError for an empty string", () => {
    expect(() => validateNetworkName("")).toThrow(UnsupportedNetworkError);
  });

  it("throws UnsupportedNetworkError for a mismatched-network-id typo", () => {
    expect(() => validateNetworkName("main-net")).toThrow(UnsupportedNetworkError);
  });

  it("error carries the offending network and the supported list", () => {
    try {
      validateNetworkName("futurenet");
      throw new Error("expected validateNetworkName to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedNetworkError);
      const typed = err as UnsupportedNetworkError;
      expect(typed.code).toBe("unsupported_network");
      expect(typed.network).toBe("futurenet");
      expect(typed.supportedNetworks).toEqual(SUPPORTED_NETWORKS);
      expect(typed.retryable).toBe(false);
    }
  });
});

describe("ContractRegistryLoader network validation", () => {
  const registry: ContractRegistry = {
    testnet: { vault: "CVAULTTESTNET00000000000000000000000000000000000000000" },
    mainnet: { vault: "CVAULTMAINNET00000000000000000000000000000000000000000" },
    local: {},
  };

  it("resolve throws UnsupportedNetworkError for an unrecognized network id", () => {
    const loader = createContractRegistryLoader(registry);
    expect(() => loader.resolve("vault", "futurenet" as never)).toThrow(UnsupportedNetworkError);
  });

  it("resolveAll throws UnsupportedNetworkError for an unrecognized network id", () => {
    const loader = createContractRegistryLoader(registry);
    expect(() => loader.resolveAll("futurenet" as never)).toThrow(UnsupportedNetworkError);
  });

  it("requireContractId throws UnsupportedNetworkError (not the missing-contract error) for an unrecognized network id", () => {
    const loader = createContractRegistryLoader(registry);
    expect(() => loader.requireContractId("vault", "futurenet" as never)).toThrow(
      UnsupportedNetworkError,
    );
  });

  it("resolve still works normally for supported networks", () => {
    const loader = createContractRegistryLoader(registry);
    const resolved = loader.resolve("vault", "testnet");
    expect(resolved.contractId).toBe(registry.testnet.vault);
  });
});
