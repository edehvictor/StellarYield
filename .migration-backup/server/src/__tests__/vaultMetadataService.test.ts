import {
  sanitizeSvg,
  uploadVaultMetadata,
} from "../services/ipfs/vaultMetadataService";
import { validateIconAssetOrThrow } from "../utils/iconValidator";

describe("vaultMetadataService", () => {
  it("sanitizes dangerous SVG content", () => {
    const raw =
      '<svg width="100" height="100" onload="alert(1)"><script>alert("xss")</script><rect width="10" height="10" /></svg>';
    const cleaned = sanitizeSvg(raw);

    expect(cleaned).toContain("<svg");
    expect(cleaned).not.toContain("<script");
    expect(cleaned).not.toContain("onload=");
  });

  it("rejects SVG with invalid dimensions during sanitization", () => {
    const tooSmall = '<svg width="10" height="10"><rect width="10" height="10" /></svg>';

    expect(() => validateIconAssetOrThrow(tooSmall, "image/svg+xml")).toThrow(/below minimum/);
  });

  it("rejects SVG exceeding size limit during sanitization", () => {
    const tooLarge = `<svg width="100" height="100">${"x".repeat(600000)}</svg>`;

    expect(() => validateIconAssetOrThrow(tooLarge, "image/svg+xml")).toThrow(/exceeds maximum allowed size/);
  });

  it("rejects SVG with script tags during validation", () => {
    const malicious =
      '<svg width="100" height="100"><script>alert("xss")</script><rect width="100" height="100" /></svg>';

    expect(() => validateIconAssetOrThrow(malicious, "image/svg+xml")).toThrow(/script tags/);
  });

  it("accepts valid SVG with proper dimensions", () => {
    const valid = '<svg width="100" height="100"><rect width="100" height="100" /></svg>';

    expect(() => sanitizeSvg(valid)).not.toThrow();
  });

  it("returns deterministic local fallback CID without Pinata config", async () => {
    const previousPinata = process.env.PINATA_JWT;
    delete process.env.PINATA_JWT;

    const first = await uploadVaultMetadata({
      vaultName: "Core Vault",
      description: "Stable yield strategy",
      iconSvg: '<svg width="100" height="100"><rect width="100" height="100" /></svg>',
    });
    const second = await uploadVaultMetadata({
      vaultName: "Core Vault",
      description: "Stable yield strategy",
      iconSvg: '<svg width="100" height="100"><rect width="100" height="100" /></svg>',
    });

    expect(first.uploadMode).toBe("local-fallback");
    expect(first.metadataUri.startsWith("ipfs://")).toBe(true);
    expect(first.cid).toBe(second.cid);
    expect(first.iconUri).toBe(second.iconUri);

    if (previousPinata) {
      process.env.PINATA_JWT = previousPinata;
    }
  });

  it("validates icon before uploading to Pinata", async () => {
    const previousPinata = process.env.PINATA_JWT;
    process.env.PINATA_JWT = "fake-jwt-for-testing";

    const maliciousIcon = '<svg width="100" height="100"><script>alert("xss")</script></svg>';

    await expect(
      uploadVaultMetadata({
        vaultName: "Test Vault",
        description: "Test description",
        iconSvg: maliciousIcon,
      }),
    ).rejects.toThrow(/script tags/);

    if (previousPinata) {
      process.env.PINATA_JWT = previousPinata;
    } else {
      delete process.env.PINATA_JWT;
    }
  });
});
