import {
  sanitizeSvg,
  uploadVaultMetadata,
} from "../services/ipfs/vaultMetadataService";

describe("vaultMetadataService", () => {
  it("sanitizes dangerous SVG content", () => {
    const raw =
      '<svg onload="alert(1)"><script>alert("xss")</script><rect width="10" height="10" /></svg>';
    const cleaned = sanitizeSvg(raw);

    expect(cleaned).toContain("<svg");
    expect(cleaned).not.toContain("<script");
    expect(cleaned).not.toContain("onload=");
  });

  it("returns deterministic local fallback CID without Pinata config", async () => {
    const previousPinata = process.env.PINATA_JWT;
    delete process.env.PINATA_JWT;

    const first = await uploadVaultMetadata({
      vaultName: "Core Vault",
      description: "Stable yield strategy",
      iconSvg: "<svg><rect width='10' height='10' /></svg>",
    });
    const second = await uploadVaultMetadata({
      vaultName: "Core Vault",
      description: "Stable yield strategy",
      iconSvg: "<svg><rect width='10' height='10' /></svg>",
    });

    expect(first.uploadMode).toBe("local-fallback");
    expect(first.metadataUri.startsWith("ipfs://")).toBe(true);
    expect(first.cid).toBe(second.cid);
    expect(first.iconUri).toBe(second.iconUri);

    if (previousPinata) {
      process.env.PINATA_JWT = previousPinata;
    }
  });
});
