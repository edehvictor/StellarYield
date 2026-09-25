#!/usr/bin/env ts-node
/**
 * Environment Secret Drift Scanner
 *
 * Detects missing, unused, and undocumented environment variables.
 * Flags placeholder secrets in production-like configs.
 * Prints only variable names and redacted status (no values exposed).
 * Returns non-zero exit code if issues found.
 */

import fs from 'fs';
import path from 'path';
import { parseEnv, stringifyEnv } from 'dotenv';

interface EnvVariable {
  name: string;
  documented: boolean;
  used: boolean;
  isSecret: boolean;
  isPlaceholder: boolean;
  source: 'example' | 'env' | 'docs' | 'ci' | 'deployment';
  status: 'ok' | 'missing' | 'unused' | 'placeholder' | 'undocumented';
}

interface ScanResult {
  variables: Map<string, EnvVariable>;
  errors: string[];
  warnings: string[];
}

const SECRET_INDICATORS = [
  'secret',
  'key',
  'password',
  'token',
  'credential',
  'auth',
  'api_key',
  'private',
];

const PLACEHOLDER_PATTERNS = [
  /\$\{[^}]+\}/,
  /^(true|false|null|undefined|example|test|demo)$/i,
  /^(xxx|yyy|zzz|placeholder|changeme|todo|fixme)$/i,
  /^YOUR_/,
];

const PACKAGES = [
  {
    name: 'client',
    example: '.env.example',
    envFile: '.env',
    srcDir: 'src',
  },
  {
    name: 'server',
    example: '.env.example',
    envFile: '.env',
    srcDir: 'src',
  },
  {
    name: 'backend/keepers',
    example: '.env.example',
    envFile: '.env',
    srcDir: 'src',
  },
  {
    name: 'backend/rewards',
    example: '.env.example',
    envFile: '.env',
    srcDir: 'src',
  },
];

const DOCS_FILES = [
  'docs/frontend-env-reference.md',
  'docs/deployment-environment-matrix.md',
  'backend/keepers/.env.example',
];

const CI_FILES = ['.github/workflows/ci.yml'];

const DEPLOYMENT_FILES = ['vercel.json', 'docs/deployment-manifest-provenance.md'];

/**
 * Read and parse .env.example or .env files
 */
function readEnvFile(filePath: string): Map<string, string> {
  const result = new Map<string, string>();

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (match) {
      result.set(match[1], match[2]);
    }
  }

  return result;
}

/**
 * Scan source code for environment variable usage
 */
function scanSourceCode(srcDir: string): Set<string> {
  const used = new Set<string>();

  if (!fs.existsSync(srcDir)) {
    return used;
  }

  const scanDir = (dir: string) => {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        if (!file.startsWith('.') && file !== 'node_modules') {
          scanDir(filePath);
        }
      } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js')) {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Look for process.env.VAR or env.VAR patterns
        const envMatches = content.match(/process\.env\.([A-Z_0-9]+)|env\.([A-Z_0-9]+)/g);
        if (envMatches) {
          for (const match of envMatches) {
            const varName = match.replace(/process\.env\.|env\./, '');
            used.add(varName);
          }
        }
      }
    }
  };

  scanDir(srcDir);
  return used;
}

/**
 * Extract documented variables from docs
 */
function scanDocumentation(): Set<string> {
  const documented = new Set<string>();

  for (const docFile of DOCS_FILES) {
    if (!fs.existsSync(docFile)) continue;

    const content = fs.readFileSync(docFile, 'utf-8');
    const matches = content.match(/\b([A-Z_][A-Z0-9_]*)\b/g);

    if (matches) {
      for (const match of matches) {
        if (match.length > 3) {
          // Filter out common words
          documented.add(match);
        }
      }
    }
  }

  return documented;
}

/**
 * Extract environment variables from CI configuration
 */
function scanCIConfiguration(): Set<string> {
  const vars = new Set<string>();

  for (const ciFile of CI_FILES) {
    if (!fs.existsSync(ciFile)) continue;

    const content = fs.readFileSync(ciFile, 'utf-8');

    // Look for env: block or uses/with patterns
    const envMatches = content.match(/([A-Z_][A-Z0-9_]*):\s*("|'|`)/g);
    if (envMatches) {
      for (const match of envMatches) {
        const varName = match.replace(/(:|"|'|`|\s)/g, '');
        if (varName.length > 0) {
          vars.add(varName);
        }
      }
    }
  }

  return vars;
}

/**
 * Determine if value is a placeholder
 */
function isPlaceholder(value: string): boolean {
  if (!value) return false;

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Determine if variable is a secret based on name
 */
function isSecretVar(varName: string): boolean {
  const lower = varName.toLowerCase();
  return SECRET_INDICATORS.some((indicator) => lower.includes(indicator));
}

/**
 * Scan a single package directory
 */
function scanPackage(packageDir: string, packageName: string): ScanResult {
  const result: ScanResult = {
    variables: new Map(),
    errors: [],
    warnings: [],
  };

  const examplePath = path.join(packageDir, '.env.example');
  const envPath = path.join(packageDir, '.env');
  const srcPath = path.join(packageDir, 'src');

  // Read .env.example (documented variables)
  const exampleVars = readEnvFile(examplePath);
  const envVars = readEnvFile(envPath);
  const usedVars = scanSourceCode(srcPath);
  const docVars = scanDocumentation();
  const ciVars = scanCIConfiguration();

  // Merge all variables
  const allVars = new Set([
    ...exampleVars.keys(),
    ...envVars.keys(),
    ...usedVars,
    ...docVars,
    ...ciVars,
  ]);

  for (const varName of allVars) {
    const exampleValue = exampleVars.get(varName);
    const envValue = envVars.get(varName);
    const isUsed = usedVars.has(varName);
    const isDocumented = docVars.has(varName) || exampleVars.has(varName);
    const isSecret = isSecretVar(varName);
    const isPlaceholderVal = isPlaceholder(exampleValue || envValue || '');

    let status: EnvVariable['status'] = 'ok';
    if (exampleVars.has(varName) && !envVars.has(varName)) {
      status = 'missing';
    } else if (!isUsed && exampleVars.has(varName)) {
      status = 'unused';
    } else if (isPlaceholderVal && envVars.has(varName)) {
      status = 'placeholder';
    } else if (!isDocumented) {
      status = 'undocumented';
    }

    const source: EnvVariable['source'] = exampleVars.has(varName)
      ? 'example'
      : envVars.has(varName)
        ? 'env'
        : docVars.has(varName)
          ? 'docs'
          : ciVars.has(varName)
            ? 'ci'
            : 'deployment';

    result.variables.set(varName, {
      name: varName,
      documented: isDocumented,
      used: isUsed,
      isSecret,
      isPlaceholder: isPlaceholderVal,
      source,
      status,
    });

    // Record errors and warnings
    if (status === 'missing') {
      result.warnings.push(
        `[${packageName}] Missing value for documented variable: ${varName}`,
      );
    } else if (status === 'unused') {
      result.warnings.push(`[${packageName}] Unused documented variable: ${varName}`);
    } else if (status === 'placeholder') {
      result.errors.push(
        `[${packageName}] CRITICAL: Placeholder secret in env: ${varName}`,
      );
    } else if (status === 'undocumented' && isUsed) {
      result.errors.push(
        `[${packageName}] Undocumented required variable used in code: ${varName}`,
      );
    }
  }

  return result;
}

/**
 * Print results in human-readable format
 */
function printResults(allResults: Map<string, ScanResult>) {
  console.log('\n=== Environment Variable Drift Scan ===\n');

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const [packageName, result] of allResults) {
    const okVars = Array.from(result.variables.values()).filter((v) => v.status === 'ok');
    const errorVars = Array.from(result.variables.values()).filter(
      (v) => v.status === 'missing' || v.status === 'undocumented' || v.status === 'placeholder',
    );
    const warningVars = Array.from(result.variables.values()).filter((v) => v.status === 'unused');

    if (errorVars.length === 0 && warningVars.length === 0) {
      console.log(`✓ ${packageName}: All clear (${okVars.length} variables)\n`);
      continue;
    }

    console.log(`📦 ${packageName}:`);
    console.log(`   Total: ${result.variables.size} variables`);

    if (errorVars.length > 0) {
      console.log(`   ❌ ERRORS (${errorVars.length}):`);
      for (const v of errorVars) {
        console.log(`      - ${v.name} [${v.status}]`);
      }
      totalErrors += errorVars.length;
    }

    if (warningVars.length > 0) {
      console.log(`   ⚠️  WARNINGS (${warningVars.length}):`);
      for (const v of warningVars) {
        console.log(`      - ${v.name} [unused]`);
      }
      totalWarnings += warningVars.length;
    }

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.log(`      ${err}`);
      }
    }

    if (result.warnings.length > 0) {
      for (const warn of result.warnings) {
        console.log(`      ${warn}`);
      }
    }

    console.log();
  }

  console.log(
    `\nSummary: ${totalErrors} errors, ${totalWarnings} warnings\n`,
  );

  return totalErrors;
}

/**
 * Main scan function
 */
async function main() {
  const allResults = new Map<string, ScanResult>();

  console.log('🔍 Scanning environment variables...\n');

  for (const pkg of PACKAGES) {
    const fullPath = path.join(process.cwd(), pkg.name);
    if (fs.existsSync(fullPath)) {
      const result = scanPackage(fullPath, pkg.name);
      allResults.set(pkg.name, result);
    }
  }

  const errorCount = printResults(allResults);

  process.exit(errorCount > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { scanPackage, scanSourceCode, scanDocumentation };
