# Vault Icon Asset Validation

This document describes the vault icon asset validation system implemented to ensure safe and consistent icon assets for vault metadata.

## Overview

Vault icon assets are validated for:
- **File type**: Only allowed image formats (SVG, PNG, JPEG, WebP)
- **File size**: Maximum 500 KB by default
- **Dimensions**: Between 32x32 and 1024x1024 pixels
- **Security**: No malicious content (scripts, event handlers, external resources)
- **Metadata safety**: Proper MIME types and format detection

## Validation Rules

### Accepted Formats

By default, the following image formats are accepted:
- **SVG** (image/svg+xml) - Recommended for scalability
- **PNG** (image/png)
- **JPEG** (image/jpeg)
- **WebP** (image/webp)

### Size Limits

- **Maximum file size**: 500 KB (512,000 bytes)
- **Minimum dimensions**: 32x32 pixels
- **Maximum dimensions**: 1024x1024 pixels

### Security Validation (SVG)

For SVG files, the following security checks are performed:
- ❌ No `<script>` tags
- ❌ No event handlers (onclick, onload, etc.)
- ❌ No `javascript:` protocol
- ❌ No data URIs with scripts
- ❌ No external resource references (http/https in xlink:href)

### Quality Warnings

The validator provides warnings for:
- Unusual aspect ratios (< 0.5 or > 2.0)
- Missing dimension information
- Raster images (recommend SVG for better validation)

## Usage

### In Code

```typescript
import { validateIconAsset, validateIconAssetOrThrow } from '../utils/iconValidator';

// Validate and get detailed result
const result = validateIconAsset(iconContent, 'image/svg+xml');
if (!result.valid) {
  console.error('Validation errors:', result.errors);
}

// Validate and throw on error
try {
  validateIconAssetOrThrow(iconContent, 'image/svg+xml');
  // Icon is valid, proceed with upload
} catch (error) {
  console.error('Invalid icon:', error.message);
}
```

### Using the Validation Script

The validation script can be used to validate icon files before uploading:

```bash
# Validate a file
ts-node scripts/validateVaultIcon.ts path/to/icon.svg

# Validate from stdin
cat icon.svg | ts-node scripts/validateVaultIcon.ts --stdin

# Custom validation parameters
ts-node scripts/validateVaultIcon.ts icon.png \
  --max-size 100000 \
  --max-width 512 \
  --max-height 512

# Show help
ts-node scripts/validateVaultIcon.ts --help
```

### Script Options

- `--stdin` - Read icon content from stdin
- `--max-size <bytes>` - Maximum file size in bytes
- `--max-width <px>` - Maximum width in pixels
- `--max-height <px>` - Maximum height in pixels
- `--min-width <px>` - Minimum width in pixels
- `--min-height <px>` - Minimum height in pixels
- `--formats <list>` - Comma-separated list of allowed formats

## Integration

### Vault Metadata Service

The validation is automatically integrated into the vault metadata service:

```typescript
import { uploadVaultMetadata } from '../services/ipfs/vaultMetadataService';

// Icons are validated before upload
const result = await uploadVaultMetadata({
  vaultName: 'My Vault',
  description: 'A secure yield vault',
  iconSvg: '<svg width="100" height="100">...</svg>',
});
```

If validation fails, an error is thrown with details about what went wrong.

## Custom Configuration

You can customize validation rules by providing a custom configuration:

```typescript
import { validateIconAsset, IconValidationConfig } from '../utils/iconValidator';

const customConfig: IconValidationConfig = {
  maxFileSizeBytes: 1024 * 1024, // 1 MB
  maxDimensionsPx: { width: 2048, height: 2048 },
  minDimensionsPx: { width: 64, height: 64 },
  allowedFormats: ['svg', 'png'],
  allowedMimeTypes: ['image/svg+xml', 'image/png'],
};

const result = validateIconAsset(iconContent, 'image/svg+xml', customConfig);
```

## Validation Result

The validation function returns a detailed result object:

```typescript
interface IconValidationResult {
  valid: boolean;              // Overall validation status
  errors: string[];            // List of validation errors
  warnings?: string[];         // Optional warnings
  metadata?: {
    format: string;            // Detected format (svg, png, jpeg, webp)
    sizeBytes: number;         // File size in bytes
    dimensions?: {             // Extracted dimensions (if available)
      width: number;
      height: number;
    };
  };
}
```

## Examples

### Valid SVG Icon

```xml
<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="#4CAF50" />
  <path d="M30 50 L45 65 L70 35" stroke="white" stroke-width="5" fill="none" />
</svg>
```

✅ Valid: Proper dimensions, no security issues

### Invalid SVG Icon (Security)

```xml
<svg width="100" height="100" onload="alert('xss')">
  <script>alert('malicious')</script>
  <rect width="100" height="100" />
</svg>
```

❌ Invalid: Contains script tags and event handlers

### Invalid SVG Icon (Size)

```xml
<svg width="10" height="10">
  <rect width="10" height="10" />
</svg>
```

❌ Invalid: Dimensions below minimum (32x32)

## Testing

Comprehensive tests are available in:
- `server/src/utils/__tests__/iconValidator.test.ts` - Unit tests for the validator
- `server/src/__tests__/vaultMetadataService.test.ts` - Integration tests

Run tests:
```bash
npm test iconValidator
npm test vaultMetadataService
```

## Error Messages

The validator provides clear, actionable error messages:

| Error | Meaning | Solution |
|-------|---------|----------|
| "SVG contains script tags which are not allowed" | SVG has `<script>` elements | Remove all script tags |
| "SVG contains event handlers which are not allowed" | SVG has onclick, onload, etc. | Remove event handler attributes |
| "Image size exceeds maximum allowed size" | File is too large | Optimize or compress the image |
| "SVG dimensions are below minimum" | Icon is too small | Use larger dimensions (min 32x32) |
| "SVG dimensions exceed maximum" | Icon is too large | Reduce dimensions (max 1024x1024) |
| "Image format 'X' is not allowed" | Unsupported format | Convert to SVG, PNG, JPEG, or WebP |
| "MIME type mismatch" | File extension doesn't match content | Ensure file format matches extension |

## Best Practices

1. **Use SVG when possible** - Scalable, smaller file size, better validation
2. **Keep icons simple** - Avoid complex gradients and effects
3. **Optimize before upload** - Use tools like SVGO for SVG optimization
4. **Test locally first** - Use the validation script before uploading
5. **Square aspect ratio** - Use 1:1 aspect ratio for best results
6. **No external dependencies** - Embed all resources in the icon file

## Security Considerations

The validation system is designed to prevent:
- **XSS attacks** via malicious SVG content
- **Resource exhaustion** via oversized files
- **Phishing** via external resource loading
- **Code injection** via event handlers and scripts

All icons are sanitized and validated before being pinned to IPFS or published.

## Future Enhancements

Potential improvements for future versions:
- [ ] Automatic dimension extraction for raster images (requires image processing library)
- [ ] Color palette validation
- [ ] Accessibility checks (contrast ratios)
- [ ] Automatic optimization suggestions
- [ ] Support for animated icons (with restrictions)
- [ ] Icon preview generation
