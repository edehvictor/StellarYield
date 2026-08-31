import { describe, it, expect } from "vitest";
import {
  validateVaultSlug,
  normalizeVaultMetadata,
  DEFAULT_VAULT_SYMBOL,
  DEFAULT_VAULT_ISSUER,
  DEFAULT_VAULT_DECIMALS,
} from "./vaultData";

describe("validateVaultSlug", () => {
  it("validates a standard valid slug", () => {
    const result = validateVaultSlug("usdc");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("usdc");
  });

  it("normalizes casing", () => {
    const result = validateVaultSlug("USDC");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("usdc");
  });

  it("normalizes whitespace", () => {
    const result = validateVaultSlug("  xlm-usdc  ");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("xlm-usdc");
  });

  it("returns invalid for unknown slugs", () => {
    const result = validateVaultSlug("invalid-vault");
    expect(result.valid).toBe(false);
    expect(result.normalized).toBe("invalid-vault");
  });

  it("handles undefined slug", () => {
    const result = validateVaultSlug(undefined);
    expect(result.valid).toBe(false);
    expect(result.normalized).toBe("");
  });

  it("handles empty string", () => {
    const result = validateVaultSlug("");
    expect(result.valid).toBe(false);
    expect(result.normalized).toBe("");
  });

  it("validates complex valid slugs", () => {
    const result = validateVaultSlug("XLM-ETH");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("xlm-eth");
  });
});

describe("normalizeVaultMetadata", () => {
  const complete = {
    iconUrl: "https://cdn.example.com/usdc.png",
    symbol: "usdc",
    issuer: "GABCDEF...ISSUER",
    decimals: 7,
  };

  it("passes through fully valid metadata unchanged (aside from symbol casing)", () => {
    const result = normalizeVaultMetadata(complete);
    expect(result.iconUrl).toBe(complete.iconUrl);
    expect(result.symbol).toBe("USDC");
    expect(result.issuer).toBe(complete.issuer);
    expect(result.decimals).toBe(7);
    expect(result.hasFallback).toBe(false);
    expect(result.fallback).toEqual({ icon: false, symbol: false, issuer: false, decimals: false });
  });

  it("falls back to a generated icon when iconUrl is missing", () => {
    const result = normalizeVaultMetadata({ ...complete, iconUrl: undefined });
    expect(result.iconUrl).toBeNull();
    expect(result.fallback.icon).toBe(true);
    expect(result.hasFallback).toBe(true);
  });

  it("falls back to a generated icon when iconUrl is malformed (not a URL)", () => {
    const result = normalizeVaultMetadata({ ...complete, iconUrl: "not-a-url" });
    expect(result.iconUrl).toBeNull();
    expect(result.fallback.icon).toBe(true);
  });

  it("rejects a non-http(s) iconUrl (e.g. javascript: scheme)", () => {
    const result = normalizeVaultMetadata({ ...complete, iconUrl: "javascript:alert(1)" });
    expect(result.iconUrl).toBeNull();
    expect(result.fallback.icon).toBe(true);
  });

  it("falls back to the default issuer when issuer is missing", () => {
    const result = normalizeVaultMetadata({ ...complete, issuer: undefined });
    expect(result.issuer).toBe(DEFAULT_VAULT_ISSUER);
    expect(result.fallback.issuer).toBe(true);
  });

  it("falls back to the default issuer when issuer is an empty/whitespace string", () => {
    const result = normalizeVaultMetadata({ ...complete, issuer: "   " });
    expect(result.issuer).toBe(DEFAULT_VAULT_ISSUER);
    expect(result.fallback.issuer).toBe(true);
  });

  it("falls back to the default symbol when symbol is missing", () => {
    const result = normalizeVaultMetadata({ ...complete, symbol: undefined });
    expect(result.symbol).toBe(DEFAULT_VAULT_SYMBOL);
    expect(result.fallback.symbol).toBe(true);
  });

  it("falls back to the default symbol when symbol contains invalid characters", () => {
    const result = normalizeVaultMetadata({ ...complete, symbol: "US$D!" });
    expect(result.symbol).toBe(DEFAULT_VAULT_SYMBOL);
    expect(result.fallback.symbol).toBe(true);
  });

  it("falls back to the default symbol when symbol exceeds 12 characters", () => {
    const result = normalizeVaultMetadata({ ...complete, symbol: "THISISWAYTOOLONG" });
    expect(result.symbol).toBe(DEFAULT_VAULT_SYMBOL);
    expect(result.fallback.symbol).toBe(true);
  });

  it("falls back to default decimals when decimals is missing", () => {
    const result = normalizeVaultMetadata({ ...complete, decimals: undefined });
    expect(result.decimals).toBe(DEFAULT_VAULT_DECIMALS);
    expect(result.fallback.decimals).toBe(true);
  });

  it("falls back to default decimals when decimals is negative", () => {
    const result = normalizeVaultMetadata({ ...complete, decimals: -1 });
    expect(result.decimals).toBe(DEFAULT_VAULT_DECIMALS);
    expect(result.fallback.decimals).toBe(true);
  });

  it("falls back to default decimals when decimals is non-integer", () => {
    const result = normalizeVaultMetadata({ ...complete, decimals: 7.5 });
    expect(result.decimals).toBe(DEFAULT_VAULT_DECIMALS);
    expect(result.fallback.decimals).toBe(true);
  });

  it("falls back to default decimals when decimals is unreasonably large", () => {
    const result = normalizeVaultMetadata({ ...complete, decimals: 100 });
    expect(result.decimals).toBe(DEFAULT_VAULT_DECIMALS);
    expect(result.fallback.decimals).toBe(true);
  });

  it("handles null metadata by falling back on every field", () => {
    const result = normalizeVaultMetadata(null);
    expect(result).toEqual({
      iconUrl: null,
      symbol: DEFAULT_VAULT_SYMBOL,
      issuer: DEFAULT_VAULT_ISSUER,
      decimals: DEFAULT_VAULT_DECIMALS,
      fallback: { icon: true, symbol: true, issuer: true, decimals: true },
      hasFallback: true,
    });
  });

  it("handles undefined metadata by falling back on every field", () => {
    const result = normalizeVaultMetadata(undefined);
    expect(result.hasFallback).toBe(true);
    expect(result.fallback).toEqual({ icon: true, symbol: true, issuer: true, decimals: true });
  });

  it("is deterministic for the same malformed input", () => {
    const input = { symbol: "bad symbol", decimals: -5 };
    expect(normalizeVaultMetadata(input)).toEqual(normalizeVaultMetadata(input));
  });
});
