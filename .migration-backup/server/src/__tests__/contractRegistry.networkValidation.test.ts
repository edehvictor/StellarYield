/**
 * Tests for centralized network id validation in the server contract
 * registry (#1109).
 */

import {
  getContractId,
  getAllContractIds,
  isSupportedNetwork,
  UnsupportedNetworkError,
  SUPPORTED_NETWORKS,
  type NetworkName,
} from "../services/contractRegistry";

describe("server contractRegistry network validation", () => {
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
    it("throws UnsupportedNetworkError for an unrecognized network id", () => {
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
    it("throws UnsupportedNetworkError for an unrecognized network id", () => {
      expect(() => getAllContractIds("futurenet" as NetworkName)).toThrow(UnsupportedNetworkError);
    });

    it("returns a full contract map for a supported network", () => {
      const ids = getAllContractIds("testnet");
      expect(ids).toHaveProperty("vault");
      expect(ids).toHaveProperty("zap");
    });
  });
});
