#!/usr/bin/env node
/**
 * CI guardrail — check-frontend-env.js  (Issue #717)
 *
 * Scans client-side source files for VITE_ environment variables that
 * contain secrets. Any VITE_ variable whose name ends with SECRET or KEY
 * (case-insensitive) — except allowed exceptions — triggers a non-zero exit
 * so the CI pipeline fails.
 *
 * Allowed exceptions (safe public keys):
 *   VITE_GOOGLE_CLIENT_ID   — public OAuth client ID, not a secret
 *   VITE_*_CONTRACT_ID      — Soroban contract addresses, not secrets
 *
 * Usage:
 *   node scripts/check-frontend-env.js
 *   # or in CI:
 *   node scripts/check-frontend-env.js && echo "✅ No unsafe VITE_ secrets"
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CLIENT_DIR = path.resolve(__dirname, "../client/src");
const ENV_FILES = [
  path.resolve(__dirname, "../client/.env"),
  path.resolve(__dirname, "../client/.env.example"),
  path.resolve(__dirname, "../client/.env.production"),
];

// Regex to find any VITE_ variable references
const VITE_PATTERN = /VITE_([A-Z0-9_]+)/g;

// Variables that are allowed despite containing SECRET/KEY
const ALLOWED = new Set([
  "VITE_GOOGLE_CLIENT_ID",
]);

const SECRET_SUFFIX = /(SECRET|KEY)$/i;
const SAFE_SUFFIX = /(CONTRACT_ID|CLIENT_ID)$/i;

let violations = [];

function checkLine(source, lineNumber, line) {
  let match;
  while ((match = VITE_PATTERN.exec(line)) !== null) {
    const fullName = `VITE_${match[1]}`;
    if (
      SECRET_SUFFIX.test(fullName) &&
      !SAFE_SUFFIX.test(fullName) &&
      !ALLOWED.has(fullName)
    ) {
      violations.push({ source, lineNumber, name: fullName });
    }
  }
  // Reset lastIndex for reuse
  VITE_PATTERN.lastIndex = 0;
}

function scanFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  lines.forEach((line, i) => checkLine(filePath, i + 1, line));
}

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        scanDirectory(fullPath);
      }
    } else if (/\.(ts|tsx|js|jsx|env|env\.example|env\.production)$/.test(entry.name)) {
      scanFile(fullPath);
    }
  }
}

// Scan source files
scanDirectory(CLIENT_DIR);

// Scan .env files
ENV_FILES.forEach(scanFile);

if (violations.length > 0) {
  console.error("\n❌ Unsafe VITE_ secrets detected in frontend code:\n");
  for (const v of violations) {
    console.error(`  ${path.relative(process.cwd(), v.source)}:${v.lineNumber}  →  ${v.name}`);
  }
  console.error(
    "\nMove these secrets to server-side environment variables (without VITE_ prefix).\n" +
    "They should only be accessed via secure backend API routes.\n"
  );
  process.exit(1);
} else {
  console.log("✅ No unsafe VITE_ secrets found in frontend code.");
  process.exit(0);
}
