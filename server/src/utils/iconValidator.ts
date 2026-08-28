/**
 * Icon Asset Validation Utility
 * Validates image files for type, size, dimensions, and metadata safety
 */

export interface IconValidationConfig {
  maxFileSizeBytes: number;
  maxDimensionsPx: { width: number; height: number };
  minDimensionsPx: { width: number; height: number };
  allowedFormats: string[];
  allowedMimeTypes: string[];
}

export interface IconValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  metadata?: {
    format: string;
    sizeBytes: number;
    dimensions?: { width: number; height: number };
  };
}

// Default configuration for vault icons
export const DEFAULT_ICON_CONFIG: IconValidationConfig = {
  maxFileSizeBytes: 500 * 1024, // 500 KB
  maxDimensionsPx: { width: 1024, height: 1024 },
  minDimensionsPx: { width: 32, height: 32 },
  allowedFormats: ["svg", "png", "jpg", "jpeg", "webp"],
  allowedMimeTypes: [
    "image/svg+xml",
    "image/png",
    "image/jpeg",
    "image/webp",
  ],
};

/**
 * Validates SVG content for security issues
 */
function validateSvgSecurity(svgContent: string): string[] {
  const errors: string[] = [];

  // Check for script tags
  if (/<script[\s\S]*?>/i.test(svgContent)) {
    errors.push("SVG contains script tags which are not allowed");
  }

  // Check for event handlers
  if (/\son\w+\s*=/i.test(svgContent)) {
    errors.push("SVG contains event handlers which are not allowed");
  }

  // Check for javascript: protocol
  if (/javascript:/i.test(svgContent)) {
    errors.push("SVG contains javascript: protocol which is not allowed");
  }

  // Check for data: URIs with scripts
  if (/data:.*script/i.test(svgContent)) {
    errors.push("SVG contains data URIs with scripts which are not allowed");
  }

  // Check for external resource loading
  if (/<use[\s\S]*?xlink:href\s*=\s*["']https?:/i.test(svgContent)) {
    errors.push("SVG contains external resource references which are not allowed");
  }

  return errors;
}

/**
 * Extracts SVG dimensions from viewBox or width/height attributes
 */
function extractSvgDimensions(svgContent: string): { width: number; height: number } | null {
  const svgTagMatch = svgContent.match(/<svg[\s\S]*?>/i);
  if (!svgTagMatch) return null;

  const svgTag = svgTagMatch[0];

  // Try to extract from viewBox attribute
  const viewBoxMatch = svgTag.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const values = viewBoxMatch[1].trim().split(/[\s,]+/);
    if (values.length === 4) {
      const width = parseFloat(values[2]);
      const height = parseFloat(values[3]);
      if (!isNaN(width) && !isNaN(height)) {
        return { width, height };
      }
    }
  }

  // Try to extract from width and height attributes on <svg> tag
  const widthMatch = svgTag.match(/width\s*=\s*["']?(\d+)/i);
  const heightMatch = svgTag.match(/height\s*=\s*["']?(\d+)/i);

  if (widthMatch && heightMatch) {
    return {
      width: parseInt(widthMatch[1], 10),
      height: parseInt(heightMatch[1], 10),
    };
  }

  return null;
}

/**
 * Validates SVG icon content
 */
function validateSvgIcon(
  svgContent: string,
  config: IconValidationConfig,
): IconValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if it's valid SVG
  if (!/<svg[\s\S]*?>/i.test(svgContent)) {
    errors.push("Content is not a valid SVG");
    return { valid: false, errors };
  }

  // Security validation
  const securityErrors = validateSvgSecurity(svgContent);
  errors.push(...securityErrors);

  // Size validation
  const sizeBytes = Buffer.byteLength(svgContent, "utf8");
  if (sizeBytes > config.maxFileSizeBytes) {
    errors.push(
      `SVG size (${sizeBytes} bytes) exceeds maximum allowed size (${config.maxFileSizeBytes} bytes)`,
    );
  }

  // Dimension validation
  const dimensions = extractSvgDimensions(svgContent);
  if (dimensions) {
    if (
      dimensions.width < config.minDimensionsPx.width ||
      dimensions.height < config.minDimensionsPx.height
    ) {
      errors.push(
        `SVG dimensions (${dimensions.width}x${dimensions.height}) are below minimum (${config.minDimensionsPx.width}x${config.minDimensionsPx.height})`,
      );
    }

    if (
      dimensions.width > config.maxDimensionsPx.width ||
      dimensions.height > config.maxDimensionsPx.height
    ) {
      errors.push(
        `SVG dimensions (${dimensions.width}x${dimensions.height}) exceed maximum (${config.maxDimensionsPx.width}x${config.maxDimensionsPx.height})`,
      );
    }

    // Warn if aspect ratio is unusual
    const aspectRatio = dimensions.width / dimensions.height;
    if (aspectRatio < 0.5 || aspectRatio > 2) {
      warnings.push(
        `SVG has unusual aspect ratio (${aspectRatio.toFixed(2)}). Consider using a more square icon.`,
      );
    }
  } else {
    warnings.push("Could not extract SVG dimensions. Ensure viewBox or width/height attributes are set.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
    metadata: {
      format: "svg",
      sizeBytes,
      dimensions: dimensions || undefined,
    },
  };
}

/**
 * Detects image format from content
 */
function detectImageFormat(content: Buffer | string): string | null {
  const buffer = typeof content === "string" ? Buffer.from(content) : content;

  // Check magic numbers
  if (buffer.length < 4) return null;

  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  // WebP: RIFF ... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12
  ) {
    if (
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return "webp";
    }
  }

  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "gif";
  }

  // SVG (text-based)
  if (typeof content === "string" && /<svg[\s\S]*?>/i.test(content)) {
    return "svg";
  }

  return null;
}

/**
 * Validates raster image (PNG, JPEG, WebP)
 * Note: This is a basic validation. For production, consider using a library like 'sharp' or 'image-size'
 */
function validateRasterIcon(
  content: Buffer,
  format: string,
  config: IconValidationConfig,
): IconValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Size validation
  const sizeBytes = content.length;
  if (sizeBytes > config.maxFileSizeBytes) {
    errors.push(
      `Image size (${sizeBytes} bytes) exceeds maximum allowed size (${config.maxFileSizeBytes} bytes)`,
    );
  }

  // Basic format validation
  const detectedFormat = detectImageFormat(content);
  if (!detectedFormat) {
    errors.push("Could not detect valid image format");
  } else if (detectedFormat !== format) {
    errors.push(`Image format mismatch: expected ${format}, detected ${detectedFormat}`);
  }

  // For now, we'll add a warning
  warnings.push(
    "Dimension validation for raster images requires additional dependencies. Consider using SVG for better validation.",
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
    metadata: {
      format,
      sizeBytes,
    },
  };
}

/**
 * Main validation function for icon assets
 */
export function validateIconAsset(
  content: string | Buffer,
  mimeType?: string,
  config: IconValidationConfig = DEFAULT_ICON_CONFIG,
): IconValidationResult {
  const errors: string[] = [];

  // Detect format
  const detectedFormat = detectImageFormat(content);
  if (!detectedFormat) {
    errors.push("Could not detect image format. Ensure the file is a valid image.");
    return { valid: false, errors };
  }

  // Validate format is allowed
  if (!config.allowedFormats.includes(detectedFormat)) {
    errors.push(
      `Image format '${detectedFormat}' is not allowed. Allowed formats: ${config.allowedFormats.join(", ")}`,
    );
    return { valid: false, errors };
  }

  // Validate MIME type if provided
  if (mimeType) {
    const expectedMimeTypes = {
      svg: "image/svg+xml",
      png: "image/png",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    };

    const expectedMime = expectedMimeTypes[detectedFormat as keyof typeof expectedMimeTypes];
    if (expectedMime && mimeType !== expectedMime) {
      errors.push(
        `MIME type mismatch: expected '${expectedMime}' for ${detectedFormat}, got '${mimeType}'`,
      );
    }
  }

  // Format-specific validation
  let result: IconValidationResult;
  if (detectedFormat === "svg") {
    const svgContent = typeof content === "string" ? content : content.toString("utf8");
    result = validateSvgIcon(svgContent, config);
  } else {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    result = validateRasterIcon(buffer, detectedFormat, config);
  }

  if (errors.length > 0) {
    const combinedErrors = [...errors, ...(result.errors || [])];
    result = {
      ...result,
      valid: combinedErrors.length === 0,
      errors: combinedErrors,
    };
  }

  return result;
}

/**
 * Validates icon asset and throws error if invalid
 */
export function validateIconAssetOrThrow(
  content: string | Buffer,
  mimeType?: string,
  config: IconValidationConfig = DEFAULT_ICON_CONFIG,
): void {
  const result = validateIconAsset(content, mimeType, config);

  if (!result.valid) {
    throw new Error(`Icon validation failed: ${result.errors.join("; ")}`);
  }
}
