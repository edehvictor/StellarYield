/**
 * Protocol Adapter Compliance Test Harness (#417)
 *
 * Reusable test helpers that verify every protocol adapter returns required
 * fields, handles stale data, normalizes errors, and covers partial payloads.
 *
 * Apply this harness to any adapter by calling `runAdapterComplianceSuite`.
 */

import {
  runProtocolAdapterComplianceChecks,
  validateProtocolAdapterPayload,
  normalizeAdapterError,
  checkAdapterStale,
  type ProtocolAdapterPayload,
} from "../protocolAdapterCompliance";

// ── Shared helpers ────────────────────────────────────────────────────────────

function freshTimestamp(offsetMs = 0): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

function makeValidPayload(overrides: Partial<ProtocolAdapterPayload> = {}): ProtocolAdapterPayload {
  return {
    protocolName: "TestProtocol",
    vaultId: "test-vault-001",
    apy: 7.5,
    tvlUsd: 1_000_000,
    fetchedAt: freshTimestamp(),
    ...overrides,
  };
}

// ── Reusable compliance suite ─────────────────────────────────────────────────

/**
 * Run the full compliance suite against a named adapter factory.
 * Call this from any protocol-specific test file:
 *
 *   runAdapterComplianceSuite("Blend", () => blendAdapter.fetch());
 */
export function runAdapterComplianceSuite(
  adapterName: string,
  successAdapter: () => Promise<unknown>,
) {
  describe(`${adapterName} adapter compliance`, () => {
    it("succeeds with a valid fresh payload", async () => {
      const report = await runProtocolAdapterComplianceChecks(adapterName, successAdapter);
      expect(report.success).toBe(true);
      expect(report.staleData).toBe(false);
      expect(report.partialData).toBe(false);
      expect(report.providerFailure).toBe(false);
      expect(report.payload).toBeDefined();
    });

    it("flags stale data when fetchedAt is too old", async () => {
      const staleAdapter = async () =>
        makeValidPayload({ fetchedAt: freshTimestamp(10 * 60 * 1000) }); // 10 min ago
      const report = await runProtocolAdapterComplianceChecks(adapterName, staleAdapter);
      expect(report.staleData).toBe(true);
      expect(report.success).toBe(false);
    });

    it("flags provider failure when adapter throws", async () => {
      const failingAdapter = async () => {
        throw new Error("upstream timeout");
      };
      const report = await runProtocolAdapterComplianceChecks(adapterName, failingAdapter);
      expect(report.providerFailure).toBe(true);
      expect(report.success).toBe(false);
      expect(report.normalizedError).toContain("upstream timeout");
    });

    it("flags partial data when required fields are missing", async () => {
      const partialAdapter = async () => ({
        protocolName: adapterName,
        vaultId: "vault-x",
        // apy and tvlUsd intentionally missing
        fetchedAt: freshTimestamp(),
      });
      const report = await runProtocolAdapterComplianceChecks(adapterName, partialAdapter);
      expect(report.success).toBe(false);
      expect(report.details.length).toBeGreaterThan(0);
    });
  });
}

// ── Unit tests for compliance primitives ─────────────────────────────────────

describe("validateProtocolAdapterPayload", () => {
  it("accepts a fully valid payload", () => {
    const result = validateProtocolAdapterPayload(makeValidPayload());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stale).toBe(false);
  });

  it("rejects null input", () => {
    const result = validateProtocolAdapterPayload(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects missing protocolName", () => {
    const result = validateProtocolAdapterPayload({ ...makeValidPayload(), protocolName: "" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("protocolName"))).toBe(true);
  });

  it("rejects non-finite apy", () => {
    const result = validateProtocolAdapterPayload({ ...makeValidPayload(), apy: NaN });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("apy"))).toBe(true);
  });

  it("rejects non-finite tvlUsd", () => {
    const result = validateProtocolAdapterPayload({ ...makeValidPayload(), tvlUsd: Infinity });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tvlUsd"))).toBe(true);
  });

  it("rejects invalid fetchedAt timestamp", () => {
    const result = validateProtocolAdapterPayload({ ...makeValidPayload(), fetchedAt: "not-a-date" });
    expect(result.valid).toBe(false);
    expect(result.stale).toBe(true);
  });

  it("marks stale when fetchedAt is older than threshold", () => {
    const stalePayload = makeValidPayload({ fetchedAt: freshTimestamp(10 * 60 * 1000) });
    const result = validateProtocolAdapterPayload(stalePayload);
    expect(result.stale).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("marks partial when some but not all required fields are missing", () => {
    const result = validateProtocolAdapterPayload({
      protocolName: "Blend",
      vaultId: "blend-001",
      fetchedAt: freshTimestamp(),
      // apy and tvlUsd missing
    });
    expect(result.partial).toBe(true);
  });
});

describe("checkAdapterStale", () => {
  it("returns false for a fresh timestamp", () => {
    expect(checkAdapterStale(freshTimestamp())).toBe(false);
  });

  it("returns true for a timestamp older than threshold", () => {
    expect(checkAdapterStale(freshTimestamp(6 * 60 * 1000))).toBe(true);
  });

  it("returns true for an invalid timestamp", () => {
    expect(checkAdapterStale("invalid")).toBe(true);
  });

  it("respects custom stale threshold", () => {
    const ts = freshTimestamp(2 * 60 * 1000); // 2 min ago
    expect(checkAdapterStale(ts, 1 * 60 * 1000)).toBe(true); // 1 min threshold
    expect(checkAdapterStale(ts, 5 * 60 * 1000)).toBe(false); // 5 min threshold
  });
});

describe("normalizeAdapterError", () => {
  it("extracts message from Error instances", () => {
    expect(normalizeAdapterError(new Error("rpc failed"))).toBe("rpc failed");
  });

  it("returns string errors as-is", () => {
    expect(normalizeAdapterError("timeout")).toBe("timeout");
  });

  it("serializes unknown error shapes", () => {
    const result = normalizeAdapterError({ code: 503 });
    expect(typeof result).toBe("string");
    expect(result).toContain("503");
  });
});

describe("runProtocolAdapterComplianceChecks", () => {
  it("returns success for a valid adapter", async () => {
    const adapter = async () => makeValidPayload({ protocolName: "Blend" });
    const report = await runProtocolAdapterComplianceChecks("Blend", adapter);
    expect(report.success).toBe(true);
    expect(report.adapterName).toBe("Blend");
    expect(report.payload?.protocolName).toBe("Blend");
  });

  it("captures thrown errors as providerFailure", async () => {
    const adapter = async (): Promise<unknown> => {
      throw new Error("connection refused");
    };
    const report = await runProtocolAdapterComplianceChecks("Soroswap", adapter);
    expect(report.providerFailure).toBe(true);
    expect(report.normalizedError).toBe("connection refused");
  });

  it("detects stale payload from adapter", async () => {
    const adapter = async () => makeValidPayload({ fetchedAt: freshTimestamp(10 * 60 * 1000) });
    const report = await runProtocolAdapterComplianceChecks("DeFindex", adapter);
    expect(report.staleData).toBe(true);
    expect(report.success).toBe(false);
  });
});

// ── Apply harness to mock adapters (Blend + Soroswap) ────────────────────────

const blendMockAdapter = async (): Promise<ProtocolAdapterPayload> =>
  makeValidPayload({ protocolName: "Blend", vaultId: "blend-vault-001", apy: 6.5, tvlUsd: 12_000_000 });

const soroswapMockAdapter = async (): Promise<ProtocolAdapterPayload> =>
  makeValidPayload({ protocolName: "Soroswap", vaultId: "soroswap-pool-001", apy: 11.2, tvlUsd: 4_500_000 });

runAdapterComplianceSuite("Blend", blendMockAdapter);
runAdapterComplianceSuite("Soroswap", soroswapMockAdapter);
