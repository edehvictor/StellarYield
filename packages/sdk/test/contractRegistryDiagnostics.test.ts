import { describe, expect, it } from "vitest";
import {
  ContractRegistryError,
  ContractRegistryLoader,
  createContractRegistryLoader,
  areDiagnosticsPrivacySafe,
  type ContractRegistry,
} from "../src";

describe("SDK Contract Registry Diagnostic Context Hardening", () => {
  const validRegistry: ContractRegistry = {
    testnet: { vault: "CTESTNETVAULT001", token: "CTESTNETTOKEN001" },
    mainnet: { vault: "CMAINNETVAULT001" },
    local: {},
  };

  describe("Normal operation", () => {
    it("resolves contracts cleanly with empty diagnostics on a valid registry", () => {
      const loader = createContractRegistryLoader(validRegistry);
      expect(loader.usedFallback).toBe(false);
      expect(loader.diagnostics).toEqual([]);

      const result = loader.resolveWithDiagnostics("vault", "testnet");
      expect(result.ok).toBe(true);
      expect(result.resolved.contractId).toBe("CTESTNETVAULT001");
      expect(result.diagnostics).toEqual([]);
      expect(loader.requireContractId("vault", "testnet")).toBe("CTESTNETVAULT001");
    });

    it("updates active registry on reload with valid data", () => {
      const loader = createContractRegistryLoader(validRegistry);
      const updated: ContractRegistry = {
        testnet: { vault: "CTESTNETVAULT002" },
        mainnet: { vault: "CMAINNETVAULT002" },
        local: {},
      };

      const reloadResult = loader.reload(updated);
      expect(reloadResult.ok).toBe(true);
      expect(reloadResult.diagnostics).toEqual([]);
      expect(loader.usedFallback).toBe(false);
      expect(loader.requireContractId("vault", "testnet")).toBe("CTESTNETVAULT002");
    });
  });

  describe("Insufficient diagnostic context and privacy-safe diagnostics", () => {
    it("records CONTEXT_INSUFFICIENT and STATE_PRESERVED when falling back from null/malformed registry", () => {
      const loader = createContractRegistryLoader(null);
      expect(loader.usedFallback).toBe(true);
      expect(loader.diagnostics.length).toBe(2);

      const [primary, statePreserved] = loader.diagnostics;
      expect(primary.code).toBe("CONTEXT_INSUFFICIENT");
      expect(primary.stage).toBe("contract-registry");
      expect(primary.retryable).toBe(true);
      expect(primary.privacySafe).toBe(true);
      expect(primary.remediation.length).toBeGreaterThan(0);

      expect(statePreserved.code).toBe("STATE_PRESERVED");
      expect(statePreserved.stage).toBe("state-persistence");
      expect(statePreserved.affectedStages).toEqual(["contract-registry"]);
      expect(areDiagnosticsPrivacySafe(loader.diagnostics)).toBe(true);
    });

    it("redacts sensitive credentials, keys, and paths in fallback reasons", () => {
      const sensitiveReason =
        "Failed to load C:\\Users\\admin\\secrets.json from https://user:pass@internal.rpc/registry with Bearer eyJhbGciOiJIUzI1NiJ9.secret and SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const loader = ContractRegistryLoader.withFallback(sensitiveReason);

      expect(loader.diagnostics.length).toBe(2);
      expect(areDiagnosticsPrivacySafe(loader.diagnostics)).toBe(true);
      expect(loader.warnings[0]?.message).not.toContain("pass@");
      expect(loader.warnings[0]?.message).not.toContain("secrets.json");
      expect(loader.warnings[0]?.message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(loader.diagnostics[0]?.summary).not.toContain("pass@");
    });

    it("handles empty or omitted fallback reason safely", () => {
      const loader = ContractRegistryLoader.withFallback(undefined);
      expect(loader.diagnostics.length).toBe(2);
      expect(loader.diagnostics[0]?.code).toBe("CONTEXT_INSUFFICIENT");
      expect(loader.diagnostics[0]?.stage).toBe("contract-registry");
      expect(areDiagnosticsPrivacySafe(loader.diagnostics)).toBe(true);
    });

    it("throws ContractRegistryError with privacy-safe diagnostics from requireContractId", () => {
      const loader = createContractRegistryLoader(validRegistry);

      expect(() => loader.requireContractId("zap", "mainnet")).toThrow(ContractRegistryError);

      try {
        loader.requireContractId("zap", "mainnet");
      } catch (err) {
        expect(err).toBeInstanceOf(ContractRegistryError);
        const registryErr = err as ContractRegistryError;
        expect(registryErr.code).toBe("CONTEXT_INSUFFICIENT");
        expect(registryErr.stage).toBe("contract-registry");
        expect(registryErr.retryable).toBe(true);
        expect(registryErr.statePreserved).toBe(true);
        expect(registryErr.contract).toBe("zap");
        expect(registryErr.network).toBe("mainnet");

        const [primary, statePreserved] = registryErr.diagnostics;
        expect(primary.code).toBe("CONTEXT_INSUFFICIENT");
        expect(primary.stage).toBe("contract-registry");
        expect(statePreserved.code).toBe("STATE_PRESERVED");
        expect(statePreserved.stage).toBe("state-persistence");
        expect(areDiagnosticsPrivacySafe(registryErr.diagnostics)).toBe(true);
      }
    });

    it("returns structured failure diagnostics from resolveWithDiagnostics without throwing", () => {
      const loader = createContractRegistryLoader(validRegistry);
      const res = loader.resolveWithDiagnostics("governance", "testnet");

      expect(res.ok).toBe(false);
      expect(res.resolved.contractId).toBe("");
      expect(res.diagnostics.length).toBe(2);
      expect(res.diagnostics[0]?.code).toBe("CONTEXT_INSUFFICIENT");
      expect(res.diagnostics[0]?.stage).toBe("contract-registry");
      expect(res.diagnostics[1]?.code).toBe("STATE_PRESERVED");
      expect(areDiagnosticsPrivacySafe(res.diagnostics)).toBe(true);
    });
  });

  describe("State preservation and safe retry", () => {
    it("preserves existing valid registry state when reload receives null or malformed input", () => {
      const loader = createContractRegistryLoader(validRegistry, {
        strategy: "COVERRIDE_STRATEGY",
      });

      const nullReload = loader.reload(null);
      expect(nullReload.ok).toBe(false);
      expect(nullReload.diagnostics[0]?.code).toBe("CONTEXT_INSUFFICIENT");
      expect(nullReload.diagnostics[1]?.code).toBe("STATE_PRESERVED");
      expect(areDiagnosticsPrivacySafe(nullReload.diagnostics)).toBe(true);

      const malformedReload = loader.reload({ unknown: {} } as unknown as ContractRegistry);
      expect(malformedReload.ok).toBe(false);
      expect(malformedReload.diagnostics[0]?.code).toBe("CONTEXT_INSUFFICIENT");
      expect(malformedReload.diagnostics[1]?.code).toBe("STATE_PRESERVED");
      expect(areDiagnosticsPrivacySafe(malformedReload.diagnostics)).toBe(true);

      // Existing state and overrides remain intact
      expect(loader.usedFallback).toBe(false);
      expect(loader.requireContractId("vault", "testnet")).toBe("CTESTNETVAULT001");
      expect(loader.requireContractId("strategy", "testnet")).toBe("COVERRIDE_STRATEGY");
    });

    it("supports safe retry after initial fallback or failed reload", () => {
      const loader = createContractRegistryLoader(undefined);
      expect(loader.usedFallback).toBe(true);
      expect(() => loader.requireContractId("vault", "testnet")).toThrow(ContractRegistryError);

      // Retry with valid registry succeeds cleanly
      const retryResult = loader.reload(validRegistry);
      expect(retryResult.ok).toBe(true);
      expect(retryResult.diagnostics).toEqual([]);
      expect(loader.usedFallback).toBe(false);
      expect(loader.requireContractId("vault", "testnet")).toBe("CTESTNETVAULT001");
    });
  });
});
