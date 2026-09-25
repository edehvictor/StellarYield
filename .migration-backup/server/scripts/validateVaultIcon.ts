#!/usr/bin/env ts-node
/**
 * Vault Icon Validation Script
 * 
 * Usage:
 *   ts-node scripts/validateVaultIcon.ts <path-to-icon-file>
 *   ts-node scripts/validateVaultIcon.ts --stdin < icon.svg
 * 
 * Examples:
 *   ts-node scripts/validateVaultIcon.ts assets/vault-icon.svg
 *   cat icon.svg | ts-node scripts/validateVaultIcon.ts --stdin
 */

import * as fs from "fs";
import * as path from "path";
import {
  validateIconAsset,
  DEFAULT_ICON_CONFIG,
  IconValidationConfig,
} from "../src/utils/iconValidator";

interface ValidationOptions {
  stdin?: boolean;
  maxSize?: number;
  maxWidth?: number;
  maxHeight?: number;
  minWidth?: number;
  minHeight?: number;
  formats?: string[];
}

function parseArgs(): { filePath?: string; options: ValidationOptions } {
  const args = process.argv.slice(2);
  const options: ValidationOptions = {};
  let filePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--max-size" && i + 1 < args.length) {
      options.maxSize = parseInt(args[++i], 10);
    } else if (arg === "--max-width" && i + 1 < args.length) {
      options.maxWidth = parseInt(args[++i], 10);
    } else if (arg === "--max-height" && i + 1 < args.length) {
      options.maxHeight = parseInt(args[++i], 10);
    } else if (arg === "--min-width" && i + 1 < args.length) {
      options.minWidth = parseInt(args[++i], 10);
    } else if (arg === "--min-height" && i + 1 < args.length) {
      options.minHeight = parseInt(args[++i], 10);
    } else if (arg === "--formats" && i + 1 < args.length) {
      options.formats = args[++i].split(",");
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      filePath = arg;
    }
  }

  return { filePath, options };
}

function printHelp(): void {
  console.log(`
Vault Icon Validation Script

Usage:
  ts-node scripts/validateVaultIcon.ts <path-to-icon-file> [options]
  ts-node scripts/validateVaultIcon.ts --stdin [options] < icon.svg

Options:
  --stdin              Read icon content from stdin
  --max-size <bytes>   Maximum file size in bytes (default: 512000)
  --max-width <px>     Maximum width in pixels (default: 1024)
  --max-height <px>    Maximum height in pixels (default: 1024)
  --min-width <px>     Minimum width in pixels (default: 32)
  --min-height <px>    Minimum height in pixels (default: 32)
  --formats <list>     Comma-separated list of allowed formats (default: svg,png,jpg,jpeg,webp)
  --help, -h           Show this help message

Examples:
  ts-node scripts/validateVaultIcon.ts assets/vault-icon.svg
  ts-node scripts/validateVaultIcon.ts icon.png --max-size 100000
  cat icon.svg | ts-node scripts/validateVaultIcon.ts --stdin
  `);
}

function buildConfig(options: ValidationOptions): IconValidationConfig {
  const config = { ...DEFAULT_ICON_CONFIG };

  if (options.maxSize !== undefined) {
    config.maxFileSizeBytes = options.maxSize;
  }

  if (options.maxWidth !== undefined || options.maxHeight !== undefined) {
    config.maxDimensionsPx = {
      width: options.maxWidth ?? config.maxDimensionsPx.width,
      height: options.maxHeight ?? config.maxDimensionsPx.height,
    };
  }

  if (options.minWidth !== undefined || options.minHeight !== undefined) {
    config.minDimensionsPx = {
      width: options.minWidth ?? config.minDimensionsPx.width,
      height: options.minHeight ?? config.minDimensionsPx.height,
    };
  }

  if (options.formats !== undefined) {
    config.allowedFormats = options.formats;
  }

  return config;
}

async function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on("data", (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    process.stdin.on("error", (err) => {
      reject(err);
    });
  });
}

function detectMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };

  return mimeTypes[ext];
}

async function main(): Promise<void> {
  const { filePath, options } = parseArgs();

  if (!options.stdin && !filePath) {
    console.error("Error: Please provide a file path or use --stdin");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  try {
    let content: Buffer | string;
    let mimeType: string | undefined;

    if (options.stdin) {
      console.log("Reading icon from stdin...");
      content = await readStdin();
    } else if (filePath) {
      console.log(`Validating icon: ${filePath}`);

      if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }

      content = fs.readFileSync(filePath);
      mimeType = detectMimeType(filePath);
    } else {
      throw new Error("No input provided");
    }

    const config = buildConfig(options);
    const result = validateIconAsset(content, mimeType, config);

    console.log("\n=== Validation Result ===\n");

    if (result.metadata) {
      console.log("Metadata:");
      console.log(`  Format: ${result.metadata.format}`);
      console.log(`  Size: ${result.metadata.sizeBytes} bytes (${(result.metadata.sizeBytes / 1024).toFixed(2)} KB)`);

      if (result.metadata.dimensions) {
        console.log(
          `  Dimensions: ${result.metadata.dimensions.width}x${result.metadata.dimensions.height}`,
        );
      }
      console.log();
    }

    if (result.warnings && result.warnings.length > 0) {
      console.log("Warnings:");
      result.warnings.forEach((warning) => {
        console.log(`  ⚠️  ${warning}`);
      });
      console.log();
    }

    if (result.valid) {
      console.log("✅ Icon is valid!");
      process.exit(0);
    } else {
      console.log("❌ Icon validation failed!\n");
      console.log("Errors:");
      result.errors.forEach((error) => {
        console.log(`  ❌ ${error}`);
      });
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Validation error:");
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
