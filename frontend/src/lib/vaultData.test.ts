/**
 * vaultData.test.ts
 *
 * Unit tests for vault data fetching and formatting utilities.
 * Target: ≥ 90% line/statement coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchVaultStats,
  formatTvl,
  VAULT_REGISTRY,
} from "./vaultData";

// ── formatTvl ─────────────────────────────────────────────────────────────

describe("formatTvl", () => {
  it("formats millions with 2 decimal places", () => {
    expect(formatTvl(2_450_000)).toBe("$2.45M");
  });

  it("formats thousands with 1 decimal place", () => {
    expect(formatTvl(1_820)).toBe("$1.8K");
  });

  it("formats sub-thousand values as plain number", () => {
    expect(formatTvl(500)).toBe("$500");
  });

  it("formats zero", () => {
    expect(formatTvl(0)).toBe("$0");
  });

  it("formats exactly 1M", () => {
    expect(formatTvl(1_000_000)).toBe("$1.00M");
  });

  it("formats exactly 1K", () => {
    expect(formatTvl(1_000)).toBe("$1.0K");
  });
});

// ── VAULT_REGISTRY ────────────────────────────────────────────────────────

describe("VAULT_REGISTRY", () => {
  it("contains usdc vault", () => {
    expect(VAULT_REGISTRY["usdc"]).toBeDefined();
    expect(VAULT_REGISTRY["usdc"].asset).toBe("USDC");
  });

  it("contains xlm vault", () => {
    expect(VAULT_REGISTRY["xlm"]).toBeDefined();
  });

  it("contains xlm-usdc vault", () => {
    expect(VAULT_REGISTRY["xlm-usdc"]).toBeDefined();
  });

  it("contains xlm-eth vault", () => {
    expect(VAULT_REGISTRY["xlm-eth"]).toBeDefined();
  });

  it("contains index vault", () => {
    expect(VAULT_REGISTRY["index"]).toBeDefined();
  });

  it("contains bluechip vault", () => {
    expect(VAULT_REGISTRY["bluechip"]).toBeDefined();
  });
});

// ── fetchVaultStats ───────────────────────────────────────────────────────

describe("fetchVaultStats", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for unknown slug", async () => {
    const result = await fetchVaultStats("unknown-vault");
    expect(result).toBeNull();
  });

  it("returns null for empty slug", async () => {
    const result = await fetchVaultStats("");
    expect(result).toBeNull();
  });

  it("normalises slug to lowercase", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { protocol: "Blend", asset: "USDC", apy: 8.42, tvl: 2_450_000, risk: "Low" },
      ],
    }));

    const result = await fetchVaultStats("USDC");
    expect(result).not.toBeNull();
    expect(result?.apy).toBe(8.42);
  });

  it("returns live stats when API responds successfully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { protocol: "Blend", asset: "USDC", apy: 8.42, tvl: 2_450_000, risk: "Low" },
      ],
    }));

    const result = await fetchVaultStats("usdc");
    expect(result).not.toBeNull();
    expect(result?.apy).toBe(8.42);
    expect(result?.tvl).toBe(2_450_000);
    expect(result?.live).toBe(true);
    expect(result?.name).toBe("USDC Yield Vault");
  });

  it("returns zeroed stats with live=false when API returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));

    const result = await fetchVaultStats("usdc");
    expect(result).not.toBeNull();
    expect(result?.apy).toBe(0);
    expect(result?.tvl).toBe(0);
    expect(result?.live).toBe(false);
  });

  it("returns zeroed stats with live=false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await fetchVaultStats("xlm");
    expect(result).not.toBeNull();
    expect(result?.apy).toBe(0);
    expect(result?.live).toBe(false);
  });

  it("returns zeroed stats when vault not found in API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      // Response contains a different vault, not the requested one
      json: async () => [
        { protocol: "Soroswap", asset: "XLM-USDC", apy: 14.75, tvl: 3_100_000, risk: "Medium" },
      ],
    }));

    const result = await fetchVaultStats("usdc");
    expect(result).not.toBeNull();
    // Entry not found → apy/tvl default to 0, live=false
    expect(result?.apy).toBe(0);
    expect(result?.tvl).toBe(0);
    expect(result?.live).toBe(false);
  });

  it("matches protocol and asset case-insensitively", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { protocol: "soroswap", asset: "xlm-usdc", apy: 14.75, tvl: 3_100_000, risk: "Medium" },
      ],
    }));

    const result = await fetchVaultStats("xlm-usdc");
    expect(result?.apy).toBe(14.75);
    expect(result?.live).toBe(true);
  });

  it("uses provided apiUrl override", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchVaultStats("usdc", "https://custom-api.example.com");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://custom-api.example.com/api/yields",
      expect.any(Object),
    );
  });
});
