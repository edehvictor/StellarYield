/**
 * check-openapi-drift.ts
 *
 * Compares the Express route mounts in src/app.ts with the paths documented
 * in openapi.yaml and reports any mounts that have no matching documented path.
 *
 * Usage:
 *   npx ts-node scripts/check-openapi-drift.ts
 *
 * Exits with code 1 if drift is detected (CI-friendly).
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

// ── 1. Collect documented path prefixes from openapi.yaml ─────────────────

const specPath = path.join(ROOT, "openapi.yaml");
const specText = fs.readFileSync(specPath, "utf8");

// Match top-level path entries: lines starting with "  /api/..."
const documentedPaths = new Set<string>();
const pathLineRe = /^\s{2}(\/api\/[^\s:]+):/gm;
let m: RegExpExecArray | null;
while ((m = pathLineRe.exec(specText)) !== null) {
  // Normalise path params: /api/foo/{id} → /api/foo
  const base = m[1].replace(/\{[^}]+\}.*$/, "").replace(/\/$/, "");
  documentedPaths.add(base);
}

// ── 2. Collect mounted prefixes from src/app.ts ───────────────────────────

const appPath = path.join(ROOT, "src", "app.ts");
const appText = fs.readFileSync(appPath, "utf8");

// Match: app.use("/api/...", ...)  and  app.post("/api/...", ...)  etc.
const mountRe = /app\.(?:use|get|post|put|patch|delete)\(\s*["'](\/?api\/[^"']+)["']/g;
const mountedPaths = new Set<string>();
while ((m = mountRe.exec(appText)) !== null) {
  // Strip trailing wildcard or path variables for comparison
  const prefix = m[1].replace(/\/:[^/]+.*$/, "").replace(/\/$/, "");
  mountedPaths.add(prefix);
}

// ── 3. Compare and report ─────────────────────────────────────────────────

const undocumented: string[] = [];

for (const mount of Array.from(mountedPaths).sort()) {
  // A mount is covered if at least one documented path starts with it
  const covered = Array.from(documentedPaths).some(
    (doc) => doc === mount || doc.startsWith(mount + "/")
  );
  if (!covered) {
    undocumented.push(mount);
  }
}

const documented: string[] = [];
for (const mount of Array.from(mountedPaths).sort()) {
  const covered = Array.from(documentedPaths).some(
    (doc) => doc === mount || doc.startsWith(mount + "/")
  );
  if (covered) {
    documented.push(mount);
  }
}

console.log(`\nOpenAPI Drift Check`);
console.log(`===================`);
console.log(`Documented path prefixes : ${documentedPaths.size}`);
console.log(`Mounted route prefixes   : ${mountedPaths.size}`);

if (documented.length > 0) {
  console.log(`\n✓ Documented mounts (${documented.length}):`);
  for (const p of documented) {
    console.log(`  ${p}`);
  }
}

if (undocumented.length === 0) {
  console.log(`\n✓ No drift detected — all mounted routes are documented.\n`);
  process.exit(0);
} else {
  console.log(`\n✗ Undocumented mounts (${undocumented.length}) — add these to openapi.yaml:`);
  for (const p of undocumented) {
    console.log(`  ${p}`);
  }
  console.log();
  process.exit(1);
}
