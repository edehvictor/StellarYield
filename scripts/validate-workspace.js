#!/usr/bin/env node
/**
 * Workspace Validator
 *
 * Runs a series of validation checks across the repository to catch:
 *  - Environment variable conflicts, duplicates, and drift (check-env-vars.js)
 *  - Consistency issues that easily slip into releases
 *
 * Add new check scripts here so they are automatically run in CI and local
 * development workflows.
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CHECKS = [
  {
    id: 'env-vars',
    label: 'Environment variable consistency',
    command: 'node scripts/check-env-vars.js',
    cwd: ROOT,
  },
];

function runCheck(check) {
  console.log(`\n▶ Running: ${check.label}`);
  try {
    const out = execSync(check.command, {
      cwd: check.cwd || ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(out);
    return true;
  } catch (err) {
    console.log(err.stdout || '');
    console.log(err.stderr || '');
    return false;
  }
}

console.log('=== Workspace Validation ===');

let failed = false;
for (const check of CHECKS) {
  const ok = runCheck(check);
  if (!ok) failed = true;
}

if (failed) {
  console.log('\nValidation failed. Review the output above.');
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
  process.exit(0);
}