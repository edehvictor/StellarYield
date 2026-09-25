/**
 * check-env-drift.ts
 *
 * Scans each package's `.env.example` file against its actual source code for
 * two kinds of environment variable drift:
 *
 *  - Stale: declared in `.env.example` but never referenced in source
 *    (`process.env.X` for server/backend packages, `import.meta.env.X` for
 *    the Vite-based client).
 *  - Missing: referenced in source but not declared in `.env.example`.
 *
 * Mirrors the drift-checker pattern in `check-openapi-drift.ts`: pure
 * scanning/comparison logic is exported so it can be unit tested without
 * touching the filesystem, and this file's bottom section is only the CLI
 * driver that wires those functions to real files and an exit code.
 *
 * Usage:
 *   npx ts-node scripts/check-env-drift.ts
 *
 * Exits with code 1 if drift is detected in any scanned package (CI-friendly).
 */

import * as fs from "fs";
import * as path from "path";

// ── Pure scanning/comparison logic (unit tested) ──────────────────────────

/** One package's env-var configuration to check for drift. */
export interface EnvDriftPackage {
  /** Human-readable label for reporting, e.g. "server". */
  name: string;
  /** Absolute or repo-relative path to the package's .env.example file. */
  envExamplePath: string;
  /** Source file contents to scan for env var references. */
  sourceFiles: Array<{ path: string; content: string }>;
  /**
   * Access pattern used in this package's source, e.g. `process.env.` for
   * Node packages or `import.meta.env.` for the Vite client.
   */
  accessPrefix: string;
}

export interface EnvDriftResult {
  name: string;
  /** Declared in .env.example but never referenced in source. */
  stale: string[];
  /** Referenced in source but not declared in .env.example. */
  missing: string[];
  declaredCount: number;
  referencedCount: number;
}

/**
 * Extracts declared variable names from a `.env.example` file's contents.
 * Ignores blank lines and comments; a line like `FOO=bar` or `FOO=` yields `FOO`.
 */
export function parseEnvExample(content: string): Set<string> {
  const names = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * Extracts referenced env var names from a source file's contents, given the
 * access prefix in use (e.g. `process.env.` or `import.meta.env.`).
 *
 * Also matches bracket access (`process.env["FOO"]` / `process.env['FOO']`)
 * since both forms appear in the wild, but not fully dynamic access
 * (`process.env[someVar]`) — that can't be resolved statically and is not
 * reported either way.
 */
export function extractEnvReferences(content: string, accessPrefix: string): Set<string> {
  const names = new Set<string>();
  const escapedPrefix = accessPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const dotRe = new RegExp(`${escapedPrefix}([A-Za-z_][A-Za-z0-9_]*)`, "g");
  let m: RegExpExecArray | null;
  while ((m = dotRe.exec(content)) !== null) {
    names.add(m[1]);
  }

  const bracketRe = new RegExp(`${escapedPrefix.replace(/\\\.$/, "")}\\[\\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\\s*\\]`, "g");
  while ((m = bracketRe.exec(content)) !== null) {
    names.add(m[1]);
  }

  return names;
}

/**
 * Compares one package's declared vs. referenced env vars and reports drift.
 */
export function checkEnvDriftForPackage(pkg: EnvDriftPackage): EnvDriftResult {
  const declared = parseEnvExample(fs.readFileSync(pkg.envExamplePath, "utf8"));
  return checkEnvDriftAgainst(pkg, declared);
}

/**
 * Same as {@link checkEnvDriftForPackage} but takes the declared set directly,
 * so tests don't need real files on disk.
 */
export function checkEnvDriftAgainst(
  pkg: Pick<EnvDriftPackage, "name" | "sourceFiles" | "accessPrefix">,
  declared: Set<string>,
): EnvDriftResult {
  const referenced = new Set<string>();
  for (const file of pkg.sourceFiles) {
    for (const name of extractEnvReferences(file.content, pkg.accessPrefix)) {
      referenced.add(name);
    }
  }

  const stale = [...declared].filter((name) => !referenced.has(name)).sort();
  const missing = [...referenced].filter((name) => !declared.has(name)).sort();

  return {
    name: pkg.name,
    stale,
    missing,
    declaredCount: declared.size,
    referencedCount: referenced.size,
  };
}

// ── CLI driver ──────────────────────────────────────────────────────────

/** Recursively collects source files under `dir` matching `extensions`. */
function collectSourceFiles(dir: string, extensions: string[]): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
      results.push(...collectSourceFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push({ path: fullPath, content: fs.readFileSync(fullPath, "utf8") });
    }
  }
  return results;
}

function runCli(): void {
  const ROOT = path.resolve(__dirname, "../..");

  const packages: Array<{ name: string; envExamplePath: string; sourceDir: string; accessPrefix: string; extensions: string[] }> = [
    {
      name: "server",
      envExamplePath: path.join(ROOT, "server", ".env.example"),
      sourceDir: path.join(ROOT, "server", "src"),
      accessPrefix: "process.env.",
      extensions: [".ts", ".tsx"],
    },
    {
      name: "client",
      envExamplePath: path.join(ROOT, "client", ".env.example"),
      sourceDir: path.join(ROOT, "client", "src"),
      accessPrefix: "import.meta.env.",
      extensions: [".ts", ".tsx"],
    },
    {
      name: "backend/keepers",
      envExamplePath: path.join(ROOT, "backend", "keepers", ".env.example"),
      sourceDir: path.join(ROOT, "backend", "keepers", "src"),
      accessPrefix: "process.env.",
      extensions: [".ts", ".tsx"],
    },
  ];

  console.log(`\nEnvironment Variable Drift Check`);
  console.log(`=================================`);

  let anyDrift = false;

  for (const pkg of packages) {
    if (!fs.existsSync(pkg.envExamplePath)) {
      console.log(`\n[${pkg.name}] skipped — no .env.example at ${pkg.envExamplePath}`);
      continue;
    }

    const sourceFiles = collectSourceFiles(pkg.sourceDir, pkg.extensions);
    const result = checkEnvDriftForPackage({
      name: pkg.name,
      envExamplePath: pkg.envExamplePath,
      sourceFiles,
      accessPrefix: pkg.accessPrefix,
    });

    console.log(`\n[${result.name}] declared=${result.declaredCount} referenced=${result.referencedCount}`);

    if (result.stale.length === 0 && result.missing.length === 0) {
      console.log(`  ✓ No drift detected.`);
      continue;
    }

    anyDrift = true;

    if (result.stale.length > 0) {
      console.log(`  ✗ Stale (in .env.example, unused in source): ${result.stale.length}`);
      for (const name of result.stale) console.log(`      ${name}`);
    }
    if (result.missing.length > 0) {
      console.log(`  ✗ Missing (used in source, not in .env.example): ${result.missing.length}`);
      for (const name of result.missing) console.log(`      ${name}`);
    }
  }

  console.log();

  if (anyDrift) {
    console.log(`✗ Environment variable drift detected — see above.\n`);
    process.exit(1);
  } else {
    console.log(`✓ No environment variable drift detected across scanned packages.\n`);
    process.exit(0);
  }
}

if (require.main === module) {
  runCli();
}
