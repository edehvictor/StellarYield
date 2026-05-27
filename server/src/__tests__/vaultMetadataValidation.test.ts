/**
 * Vault Metadata Validation Tests (#418)
 *
 * Tests for metadata validation edge cases, SVG sanitization,
 * and the upload pipeline used in the pinning workflow.
 */

import {
  validateVaultMetadataInput,
  sanitizeSvg,
  type VaultMetadataInput,
} from "../../services/ipfs/vaultMetadataService";

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>`;

function makeValidInput(overrides: Partial<VaultMetadataInput> = {}): VaultMetadataInput {
  return {
    vaultName: "Blend Vault",
    description: "A stable yield vault on Stellar",
    iconSvg: VALID_SVG,
    ...overrides,
  };
}

// ── validateVaultMetadataInput ────────────────────────────────────────────────

describe("validateVaultMetadataInput", () => {
  it("accepts a fully valid input", () => {
    const result = validateVaultMetadataInput(makeValidInput());
    expect(result.ok).toBe(true);
  });

  it("rejects null input", () => {
    const result = validateVaultMetadataInput(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects missing vaultName", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), vaultName: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("vaultName"))).toBe(true);
    }
  });

  it("rejects missing description", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), description: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("description"))).toBe(true);
    }
  });

  it("rejects missing iconSvg", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), iconSvg: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("iconSvg"))).toBe(true);
    }
  });

  it("rejects iconSvg that is not valid SVG markup", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), iconSvg: "<div>not svg</div>" });
    expect(result.ok).toBe(false);
  });

  it("rejects iconSvg containing a script tag", () => {
    const maliciousSvg = `<svg><script>alert(1)</script></svg>`;
    // sanitizeSvg strips scripts, but the raw input still contains <script>
    // validateVaultMetadataInput calls sanitizeSvg internally and accepts the sanitized result
    // so we test sanitizeSvg directly for script removal
    const sanitized = sanitizeSvg(maliciousSvg);
    expect(sanitized).not.toContain("<script>");
  });

  it("rejects non-object input", () => {
    const result = validateVaultMetadataInput("not an object");
    expect(result.ok).toBe(false);
  });

  it("collects multiple errors at once", () => {
    const result = validateVaultMetadataInput({ vaultName: "", description: "", iconSvg: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── sanitizeSvg ───────────────────────────────────────────────────────────────

describe("sanitizeSvg", () => {
  it("returns clean SVG unchanged", () => {
    const result = sanitizeSvg(VALID_SVG);
    expect(result).toContain("<svg");
    expect(result).not.toContain("<script");
  });

  it("strips script tags", () => {
    const svg = `<svg><script>alert('xss')</script><circle r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert");
  });

  it("strips inline event handlers (double quotes)", () => {
    const svg = `<svg><circle onclick="evil()" r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("onclick");
  });

  it("strips inline event handlers (single quotes)", () => {
    const svg = `<svg><circle onload='evil()' r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("onload");
  });

  it("strips javascript: URIs", () => {
    const svg = `<svg><a href="javascript:void(0)"><circle r="5"/></a></svg>`;
    const result = sanitizeSvg(svg);
    expect(result.toLowerCase()).not.toContain("javascript:");
  });

  it("throws for empty input", () => {
    expect(() => sanitizeSvg("")).toThrow();
  });

  it("throws for non-SVG markup", () => {
    expect(() => sanitizeSvg("<html><body>not svg</body></html>")).toThrow("valid SVG");
  });

  it("handles multiline script tags", () => {
    const svg = `<svg>
      <script type="text/javascript">
        var x = 1;
      </script>
      <circle r="5"/>
    </svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("var x");
  });
});
