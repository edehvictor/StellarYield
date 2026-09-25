/**
 * og.test.ts
 *
 * Unit tests for the /api/og edge function handler and card builder.
 * Target: ≥ 90% line/statement coverage.
 *
 * Note: ImageResponse from @vercel/og is mocked because it requires a
 * browser-like environment with font loading that isn't available in Vitest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCardElement } from "./og";
import { VAULT_REGISTRY } from "../../lib/vaultData";

// ── Mock @vercel/og ───────────────────────────────────────────────────────

vi.mock("@vercel/og", () => ({
  ImageResponse: class MockImageResponse {
    readonly status: number;
    readonly headers: Map<string, string>;
    private _body: string;

    constructor(element: unknown, options?: { width?: number; height?: number }) {
      this.status = 200;
      this.headers = new Map([["Content-Type", "image/png"]]);
      this._body = JSON.stringify({ element: String(element), options });
    }

    set(key: string, value: string) {
      this.headers.set(key, value);
    }
  },
}));

// ── Mock vaultData ────────────────────────────────────────────────────────

vi.mock("../../lib/vaultData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/vaultData")>();
  return {
    ...actual,
    fetchVaultStats: vi.fn(),
  };
});

import { fetchVaultStats } from "../../lib/vaultData";
import handler from "./og";

// ── buildCardElement ──────────────────────────────────────────────────────

describe("buildCardElement", () => {
  it("returns a React element (object with type)", () => {
    const el = buildCardElement("USDC Vault", "USDC", "Blend", 8.42, 2_450_000);
    expect(el).toBeTruthy();
    expect(typeof el).toBe("object");
  });

  it("formats APY with 2 decimal places when apy > 0", () => {
    const el = buildCardElement("Test Vault", "XLM", "Blend", 5.1, 0);
    // The element tree is a plain object; stringify to inspect rendered values
    const str = JSON.stringify(el);
    expect(str).toContain("5.10%");
  });

  it("renders — for APY when apy is 0", () => {
    const el = buildCardElement("Test Vault", "XLM", "Blend", 0, 0);
    const str = JSON.stringify(el);
    expect(str).toContain('"—"');
  });

  it("renders — for TVL when tvl is 0", () => {
    const el = buildCardElement("Test Vault", "XLM", "Blend", 0, 0);
    const str = JSON.stringify(el);
    // Both APY and TVL show — when zero
    const dashes = (str.match(/"—"/g) ?? []).length;
    expect(dashes).toBeGreaterThanOrEqual(2);
  });

  it("includes vault name in output", () => {
    const el = buildCardElement("My Special Vault", "USDC", "Blend", 8.0, 1_000_000);
    expect(JSON.stringify(el)).toContain("My Special Vault");
  });

  it("includes asset and protocol in output", () => {
    const el = buildCardElement("Vault", "XLM-USDC", "Soroswap", 14.75, 3_100_000);
    const str = JSON.stringify(el);
    expect(str).toContain("XLM-USDC");
    expect(str).toContain("Soroswap");
  });

  it("formats TVL in millions", () => {
    const el = buildCardElement("Vault", "USDC", "Blend", 8.0, 2_450_000);
    expect(JSON.stringify(el)).toContain("$2.45M");
  });
});

// ── handler ───────────────────────────────────────────────────────────────

function makeRequest(url: string): Request {
  return new Request(url);
}

describe("handler", () => {
  beforeEach(() => {
    vi.mocked(fetchVaultStats).mockReset();
  });

  it("returns 400 when vault param is missing", async () => {
    const res = await handler(makeRequest("https://example.com/api/og") as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown vault/i);
  });

  it("returns 400 for unknown vault slug", async () => {
    const res = await handler(makeRequest("https://example.com/api/og?vault=unknown") as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unknown vault");
  });

  it("lists valid slugs in 400 error message", async () => {
    const res = await handler(makeRequest("https://example.com/api/og?vault=bad") as any);
    const body = await res.json();
    expect(body.error).toContain("usdc");
  });

  it("returns 500 when fetchVaultStats returns null unexpectedly", async () => {
    vi.mocked(fetchVaultStats).mockResolvedValue(null);
    // Temporarily remove usdc from registry to force the null path
    const original = { ...VAULT_REGISTRY };
    (VAULT_REGISTRY as Record<string, unknown>)["usdc"] = original["usdc"];

    // We need to mock fetchVaultStats to return null for a known slug
    // Patch the registry to include a slug that passes the guard but returns null stats
    (VAULT_REGISTRY as Record<string, unknown>)["test-null"] = {
      name: "Test",
      asset: "TEST",
      protocol: "Test",
    };

    const res = await handler(makeRequest("https://example.com/api/og?vault=test-null") as any);
    expect(res.status).toBe(500);

    // Cleanup
    delete (VAULT_REGISTRY as Record<string, unknown>)["test-null"];
  });

  it("returns an image response for a valid vault", async () => {
    vi.mocked(fetchVaultStats).mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 8.42,
      tvl: 2_450_000,
      live: true,
    });

    const res = await handler(makeRequest("https://example.com/api/og?vault=usdc") as any);
    expect(res.status).toBe(200);
  });

  it("sets Cache-Control header on successful response", async () => {
    vi.mocked(fetchVaultStats).mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 8.42,
      tvl: 2_450_000,
      live: true,
    });

    const res = await handler(makeRequest("https://example.com/api/og?vault=usdc") as any);
    const cc = (res.headers as unknown as Map<string, string>).get("Cache-Control");
    expect(cc).toContain("s-maxage=3600");
    expect(cc).toContain("stale-while-revalidate=86400");
  });

  it("normalises vault slug to lowercase", async () => {
    vi.mocked(fetchVaultStats).mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 8.42,
      tvl: 2_450_000,
      live: true,
    });

    const res = await handler(makeRequest("https://example.com/api/og?vault=USDC") as any);
    expect(res.status).toBe(200);
  });

  it("handles all registered vault slugs without error", async () => {
    vi.mocked(fetchVaultStats).mockResolvedValue({
      name: "Vault",
      asset: "ASSET",
      protocol: "Protocol",
      apy: 5.0,
      tvl: 1_000_000,
      live: true,
    });

    for (const slug of Object.keys(VAULT_REGISTRY)) {
      const res = await handler(
        makeRequest(`https://example.com/api/og?vault=${slug}`) as any,
      );
      expect(res.status).toBe(200);
    }
  });
});
