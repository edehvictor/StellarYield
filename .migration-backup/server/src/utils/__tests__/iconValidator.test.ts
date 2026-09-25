import {
  validateIconAsset,
  validateIconAssetOrThrow,
  DEFAULT_ICON_CONFIG,
  IconValidationConfig,
} from "../iconValidator";

describe("iconValidator", () => {
  describe("validateIconAsset - SVG", () => {
    it("validates a valid SVG icon", () => {
      const validSvg = `<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100" fill="blue" />
      </svg>`;

      const result = validateIconAsset(validSvg, "image/svg+xml");

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.metadata?.format).toBe("svg");
      expect(result.metadata?.dimensions).toEqual({ width: 100, height: 100 });
    });

    it("rejects SVG with script tags", () => {
      const maliciousSvg = `<svg width="100" height="100">
        <script>alert('xss')</script>
        <rect width="100" height="100" />
      </svg>`;

      const result = validateIconAsset(maliciousSvg, "image/svg+xml");

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("SVG contains script tags which are not allowed");
    });

    it("rejects SVG with event handlers", () => {
      const maliciousSvg = `<svg width="100" height="100" onload="alert('xss')">
        <rect width="100" height="100" />
      </svg>`;

      const result = validateIconAsset(maliciousSvg, "image/svg+xml");

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("SVG contains event handlers which are not allowed");
    });

    it("rejects SVG with javascript: protocol", () => {
      const maliciousSvg = `<svg width="100" height="100">
        <a href="javascript:alert('xss')">
          <rect width="100" height="100" />
        </a>
      </svg>`;

      const result = validateIconAsset(maliciousSvg, "image/svg+xml");

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("SVG contains javascript: protocol which is not allowed");
    });

    it("rejects SVG exceeding max file size", () => {
      const largeSvg = `<svg width="100" height="100">${"x".repeat(600000)}</svg>`;

      const result = validateIconAsset(largeSvg, "image/svg+xml");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds maximum allowed size"))).toBe(true);
    });

    it("rejects SVG with dimensions below minimum", () => {
      const tinyIcon = `<svg width="20" height="20" viewBox="0 0 20 20">
        <rect width="20" height="20" />
      </svg>`;

      const result = validateIconAsset(tinyIcon, "image/svg+xml");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("below minimum"))).toBe(true);
    });

    it("rejects SVG with dimensions exceeding maximum", () => {
      const hugeIcon = `<svg width="2000" height="2000" viewBox="0 0 2000 2000">
        <rect width="2000" height="2000" />
      </svg>`;

      const result = validateIconAsset(hugeIcon, "image/svg+xml");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceed maximum"))).toBe(true);
    });

    it("warns about unusual aspect ratio", () => {
      const wideIcon = `<svg width="400" height="100" viewBox="0 0 400 100">
        <rect width="400" height="100" />
      </svg>`;

      const result = validateIconAsset(wideIcon, "image/svg+xml");

      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.includes("unusual aspect ratio"))).toBe(true);
    });

    it("extracts dimensions from viewBox", () => {
      const svgWithViewBox = `<svg viewBox="0 0 256 256">
        <rect width="256" height="256" />
      </svg>`;

      const result = validateIconAsset(svgWithViewBox, "image/svg+xml");

      expect(result.valid).toBe(true);
      expect(result.metadata?.dimensions).toEqual({ width: 256, height: 256 });
    });

    it("extracts dimensions from width/height attributes", () => {
      const svgWithAttrs = `<svg width="128" height="128">
        <rect width="128" height="128" />
      </svg>`;

      const result = validateIconAsset(svgWithAttrs, "image/svg+xml");

      expect(result.valid).toBe(true);
      expect(result.metadata?.dimensions).toEqual({ width: 128, height: 128 });
    });

    it("warns when dimensions cannot be extracted", () => {
      const svgNoDimensions = `<svg>
        <rect width="100" height="100" />
      </svg>`;

      const result = validateIconAsset(svgNoDimensions, "image/svg+xml");

      expect(result.valid).toBe(true);
      expect(result.warnings?.some((w) => w.includes("Could not extract SVG dimensions"))).toBe(
        true,
      );
    });

    it("rejects SVG with external resource references", () => {
      const externalSvg = `<svg width="100" height="100">
        <use xlink:href="https://evil.com/icon.svg#icon" />
      </svg>`;

      const result = validateIconAsset(externalSvg, "image/svg+xml");

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "SVG contains external resource references which are not allowed",
      );
    });

    it("rejects MIME type mismatch", () => {
      const validSvg = `<svg width="100" height="100">
        <rect width="100" height="100" />
      </svg>`;

      const result = validateIconAsset(validSvg, "image/png");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("MIME type mismatch"))).toBe(true);
    });
  });

  describe("validateIconAsset - Raster Images", () => {
    it("validates PNG format by magic number", () => {
      // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ...Array(100).fill(0),
      ]);

      const result = validateIconAsset(pngBuffer, "image/png");

      expect(result.valid).toBe(true);
      expect(result.metadata?.format).toBe("png");
    });

    it("validates JPEG format by magic number", () => {
      // JPEG magic number: FF D8 FF
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0)]);

      const result = validateIconAsset(jpegBuffer, "image/jpeg");

      expect(result.valid).toBe(true);
      expect(result.metadata?.format).toBe("jpeg");
    });

    it("validates WebP format by magic number", () => {
      // WebP magic number: RIFF ... WEBP
      const webpBuffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // file size
        0x57, 0x45, 0x42, 0x50, // WEBP
        ...Array(100).fill(0),
      ]);

      const result = validateIconAsset(webpBuffer, "image/webp");

      expect(result.valid).toBe(true);
      expect(result.metadata?.format).toBe("webp");
    });

    it("rejects raster image exceeding max size", () => {
      const largePng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ...Array(600000).fill(0),
      ]);

      const result = validateIconAsset(largePng, "image/png");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds maximum allowed size"))).toBe(true);
    });

    it("rejects format mismatch for raster images", () => {
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ...Array(100).fill(0),
      ]);

      const result = validateIconAsset(pngBuffer, "image/jpeg");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("MIME type mismatch"))).toBe(true);
    });
  });

  describe("validateIconAsset - Format Detection", () => {
    it("rejects invalid/unknown format", () => {
      const invalidContent = Buffer.from("not an image");

      const result = validateIconAsset(invalidContent);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Could not detect image format. Ensure the file is a valid image.",
      );
    });

    it("rejects disallowed format", () => {
      const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a

      const customConfig: IconValidationConfig = {
        ...DEFAULT_ICON_CONFIG,
        allowedFormats: ["svg", "png"],
      };

      const result = validateIconAsset(gifBuffer, undefined, customConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("not allowed"))).toBe(true);
    });
  });

  describe("validateIconAssetOrThrow", () => {
    it("does not throw for valid icon", () => {
      const validSvg = `<svg width="100" height="100">
        <rect width="100" height="100" />
      </svg>`;

      expect(() => {
        validateIconAssetOrThrow(validSvg, "image/svg+xml");
      }).not.toThrow();
    });

    it("throws for invalid icon", () => {
      const maliciousSvg = `<svg width="100" height="100">
        <script>alert('xss')</script>
      </svg>`;

      expect(() => {
        validateIconAssetOrThrow(maliciousSvg, "image/svg+xml");
      }).toThrow("Icon validation failed");
    });

    it("includes all errors in thrown message", () => {
      const badSvg = `<svg width="10" height="10" onload="alert(1)">
        <script>alert('xss')</script>
      </svg>`;

      expect(() => {
        validateIconAssetOrThrow(badSvg, "image/svg+xml");
      }).toThrow(/script tags.*event handlers/i);
    });
  });

  describe("Custom Configuration", () => {
    it("respects custom max file size", () => {
      const svg = `<svg width="100" height="100">${"x".repeat(10000)}</svg>`;

      const customConfig: IconValidationConfig = {
        ...DEFAULT_ICON_CONFIG,
        maxFileSizeBytes: 5000,
      };

      const result = validateIconAsset(svg, "image/svg+xml", customConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds maximum allowed size"))).toBe(true);
    });

    it("respects custom dimension limits", () => {
      const svg = `<svg width="150" height="150" viewBox="0 0 150 150">
        <rect width="150" height="150" />
      </svg>`;

      const customConfig: IconValidationConfig = {
        ...DEFAULT_ICON_CONFIG,
        maxDimensionsPx: { width: 100, height: 100 },
      };

      const result = validateIconAsset(svg, "image/svg+xml", customConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceed maximum"))).toBe(true);
    });

    it("respects custom allowed formats", () => {
      const svg = `<svg width="100" height="100">
        <rect width="100" height="100" />
      </svg>`;

      const customConfig: IconValidationConfig = {
        ...DEFAULT_ICON_CONFIG,
        allowedFormats: ["png", "jpeg"],
      };

      const result = validateIconAsset(svg, "image/svg+xml", customConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("not allowed"))).toBe(true);
    });
  });
});
