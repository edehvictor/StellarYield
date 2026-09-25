#!/usr/bin/env node
/**
 * Environment Variable Consistency Checker
 *
 * Scans client, server, backend, and docs for environment variable definitions,
 * then reports duplicates, conflicting descriptions, or naming drift.
 *
 * Exit codes:
 *   0 - No issues found
 *   1 - Issues detected
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const TARGETS = [
  // .env.example / .env files
  { type: 'env', path: 'client/.env.example' },
  { type: 'env', path: 'server/.env.example' },
  { type: 'env', path: 'server/.env.audit.example' },
  { type: 'env', path: 'server/.env.weekly-reports.example' },
  { type: 'env', path: 'backend/keepers/.env.example' },

  // Docs
  { type: 'docs', path: 'docs/frontend-env-reference.md' },
  { type: 'docs', path: 'docs/deployment-environment-matrix.md' },
];

// Patterns
const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*=/;
const DOC_VAR_PATTERN = /`([A-Z_][A-Z0-9_]*)`/;

const findings = [];
const allVars = new Map(); // name -> { sources: [], descriptions: [] }

function addVar(name, source, description = null) {
  if (!allVars.has(name)) {
    allVars.set(name, { sources: [], descriptions: [] });
  }
  const entry = allVars.get(name);
  if (!entry.sources.includes(source)) {
    entry.sources.push(source);
  }
  if (description && !entry.descriptions.some(d => d === description)) {
    entry.descriptions.push(description);
  }
}

function scanEnvFile(filePath, relPath) {
  const fullPath = path.join(ROOT, filePath);
  if (!fs.existsSync(fullPath)) {
    return;
  }
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') return;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match) {
      const name = match[1];
      const descLine = lines[idx - 1] || '';
      const desc = descLine.trim().replace(/^#+\s*/, '');
      addVar(name, relPath, desc || null);
    }
  });
}

function scanDocsFile(filePath, relPath) {
  const fullPath = path.join(ROOT, filePath);
  if (!fs.existsSync(fullPath)) return;
  const content = fs.readFileSync(fullPath, 'utf8');
  const matches = content.match(DOC_VAR_PATTERN) || [];
  matches.forEach(m => addVar(m[1], relPath));
}

TARGETS.forEach(t => {
  const { type, path: filePath } = t;
  const relPath = filePath;
  if (type === 'env') scanEnvFile(filePath, relPath);
  else if (type === 'docs') scanDocsFile(filePath, relPath);
});

// Detect duplicates across different files
for (const [name, entry] of allVars.entries()) {
  const uniqueSources = [...new Set(entry.sources.map(s => s.split('/')[0]))]; // top-level dir
  if (uniqueSources.length > 1) {
    findings.push({
      severity: 'WARN',
      variable: name,
      message: `Defined in multiple surfaces: ${entry.sources.join(', ')}`,
    });
  }
}

// Check for common conflicts (e.g., duplicate keys across files)
const envDefinitions = new Map();
TARGETS.filter(t => t.type === 'env').forEach(t => {
  const fullPath = path.join(ROOT, t.path);
  if (!fs.existsSync(fullPath)) return;
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
  const definitionsInFile = new Set();
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') return;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match) {
      const key = match[1];
      if (definitionsInFile.has(key)) {
        findings.push({
          severity: 'ERROR',
          variable: key,
          message: `Duplicate definition within ${t.path}`,
        });
      }
      definitionsInFile.add(key);
      if (!envDefinitions.has(key)) envDefinitions.set(key, []);
      envDefinitions.get(key).push(t.path);
    }
  });
});

// Detect naming drift: documented but not in code, or vice versa
const documentedVars = new Set();
TARGETS.filter(t => t.type === 'docs').forEach(t => {
  const fullPath = path.join(ROOT, t.path);
  if (!fs.existsSync(fullPath)) return;
  const content = fs.readFileSync(fullPath, 'utf8');
  const matches = content.match(DOC_VAR_PATTERN) || [];
  matches.forEach(m => documentedVars.add(m[1]));
});

const envVarNames = new Set(allVars.keys());
for (const docVar of documentedVars) {
  if (!envVarNames.has(docVar)) {
    findings.push({
      severity: 'INFO',
      variable: docVar,
      message: 'Documented in docs but not found in any .env.example file',
    });
  }
}

for (const envVar of envVarNames) {
  if (!documentedVars.has(envVar)) {
    findings.push({
      severity: 'INFO',
      variable: envVar,
      message: 'Defined in .env but not documented in env reference docs',
    });
  }
}

// Print report
console.log('\n=== Env Var Consistency Report ===\n');
if (findings.length === 0) {
  console.log('No issues detected.\n');
  process.exit(0);
}

const bySeverity = { ERROR: [], WARN: [], INFO: [] };
findings.forEach(f => bySeverity[f.severity].push(f));
Object.entries(bySeverity).forEach(([sev, items]) => {
  if (items.length === 0) return;
  console.log(`[${sev}]`);
  items.forEach(item => {
    console.log(`  - ${item.variable}: ${item.message}`);
  });
  console.log('');
});

const hasErrors = findings.some(f => f.severity === 'ERROR');
const hasWarnings = findings.some(f => f.severity === 'WARN');

if (hasErrors) {
  console.log('Failed: conflicting environment variable definitions detected.\n');
  process.exit(1);
} else if (hasWarnings) {
  console.log('Warning: potential duplication or drift detected.\n');
  process.exit(0);
} else {
  console.log('Passed: no conflicting or duplicate env definitions.\n');
  process.exit(0);
}