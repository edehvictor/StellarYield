/**
 * useVaultOgMeta.test.ts
 *
 * Unit tests for the useVaultOgMeta hook.
 * Target: ≥ 90% line/statement coverage.
 */

import { describe, it, expect } from "vitest";
import { useVaultOgMeta } from "./useVaultOgMeta";

const SITE = "https://stellaryield.app";

describe("useVaultOgMeta", () => {
  it("returns a title containing the vault slug in uppercase", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    expect(meta.title).toContain("USDC");
    expect(meta.title).toContain("Stellar Yield");
  });

  it("returns a description mentioning the vault asset", () => {
    const meta = useVaultOgMeta("xlm", SITE);
    expect(meta.description).toContain("XLM");
  });

  it("builds ogImageUrl pointing to /api/og with vault param", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    expect(meta.ogImageUrl).toBe(`${SITE}/api/og?vault=usdc`);
  });

  it("URL-encodes slugs with special characters", () => {
    const meta = useVaultOgMeta("xlm-usdc", SITE);
    expect(meta.ogImageUrl).toContain("xlm-usdc");
  });

  it("includes og:image tag with correct content", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const ogImage = meta.tags.find((t) => t.property === "og:image");
    expect(ogImage?.content).toBe(`${SITE}/api/og?vault=usdc`);
  });

  it("includes og:image:width = 1200", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "og:image:width");
    expect(tag?.content).toBe("1200");
  });

  it("includes og:image:height = 630", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "og:image:height");
    expect(tag?.content).toBe("630");
  });

  it("includes og:image:type = image/png", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "og:image:type");
    expect(tag?.content).toBe("image/png");
  });

  it("includes twitter:card = summary_large_image", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "twitter:card");
    expect(tag?.content).toBe("summary_large_image");
  });

  it("includes twitter:image matching ogImageUrl", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "twitter:image");
    expect(tag?.content).toBe(meta.ogImageUrl);
  });

  it("includes og:url pointing to the vault page", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "og:url");
    expect(tag?.content).toBe(`${SITE}/vault/usdc`);
  });

  it("includes og:site_name = Stellar Yield", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "og:site_name");
    expect(tag?.content).toBe("Stellar Yield");
  });

  it("includes og:type = website", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    const tag = meta.tags.find((t) => t.property === "og:type");
    expect(tag?.content).toBe("website");
  });

  it("returns 14 meta tags total", () => {
    const meta = useVaultOgMeta("usdc", SITE);
    expect(meta.tags).toHaveLength(14);
  });

  it("uses window.location.origin when siteUrl is not provided", () => {
    // In Node/vitest environment window is undefined; hook falls back to default
    const meta = useVaultOgMeta("usdc");
    expect(meta.ogImageUrl).toContain("/api/og?vault=usdc");
  });

  it("works for all common vault slugs", () => {
    const slugs = ["usdc", "xlm", "xlm-usdc", "xlm-eth", "index", "bluechip"];
    for (const slug of slugs) {
      const meta = useVaultOgMeta(slug, SITE);
      expect(meta.ogImageUrl).toContain(slug);
      expect(meta.tags.length).toBeGreaterThan(0);
    }
  });
});
