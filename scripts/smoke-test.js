#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

// Configuration from environment variables
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_HEALTH_PATH = process.env.BACKEND_HEALTH_PATH || '/api/health';
const BACKEND_READINESS_PATH = process.env.BACKEND_READINESS_PATH || '/api/health/readiness';
const BACKEND_YIELDS_PATH = process.env.BACKEND_YIELDS_PATH || '/api/yields';
const FRONTEND_ASSET_PATH = process.env.FRONTEND_ASSET_PATH || '/favicon.svg';

function parseArgs(argv) {
  const flags = new Set();
  /** @type {{ markdownOut: string | null }} */
  const opts = { markdownOut: null };
  for (const a of argv) {
    if (a === '--report') flags.add('report');
    else if (a === '--markdown') flags.add('markdown');
    else if (a.startsWith('--markdown-out=')) {
      flags.add('markdown');
      opts.markdownOut = a.slice('--markdown-out='.length).trim() || null;
    }
  }
  return { flags, opts };
}

/**
 * Make HTTP request and return status code
 * @param {string} url - URL to test
 * @returns {Promise<number>} HTTP status code (000 if unreachable)
 */
function getStatusCode(url) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.request(url, { method: 'GET', timeout: 10000 }, (res) => {
        resolve(res.statusCode || 0);
      });

      req.on('error', () => resolve(0));
      req.on('timeout', () => {
        req.destroy();
        resolve(0);
      });

      req.end();
    } catch (_error) {
      resolve(0);
    }
  });
}

/**
 * Test endpoint and expect 200 status
 * @param {string} label - Test description
 * @param {string} url - URL to test
 * @returns {Promise<boolean>} True if test passes
 */
async function expect200(label, url) {
  const status = await getStatusCode(url);

  if (status === 200) {
    console.log(`[PASS] ${label} (200)`);
    return true;
  }
  if (status === 0) {
    console.log(`[FAIL] ${label} (unreachable)`);
    console.log(`   URL: ${url}`);
    console.log(`   Hint: set FRONTEND_URL/BACKEND_URL to deployed URLs or start local services.`);
  } else {
    console.log(`[FAIL] ${label} (${status})`);
    console.log(`   URL: ${url}`);
  }
  return false;
}

/**
 * Run all four smoke checks and return structured results (always runs every check).
 * @returns {Promise<{ ok: boolean, rows: { label: string, url: string, httpCode: number }[] }>}
 */
async function collectSmokeResults() {
  /** @type {{ label: string, url: string }[]} */
  const tests = [
    {
      label: `Backend ${BACKEND_HEALTH_PATH}`,
      url: `${BACKEND_URL}${BACKEND_HEALTH_PATH}`,
    },
    {
      label: `Backend readiness endpoint`,
      url: `${BACKEND_URL}${BACKEND_READINESS_PATH}`,
    },
    {
      label: `Backend ${BACKEND_YIELDS_PATH}`,
      url: `${BACKEND_URL}${BACKEND_YIELDS_PATH}`,
    },
    {
      label: 'Frontend /',
      url: `${FRONTEND_URL}/`,
    },
    {
      label: `Frontend ${FRONTEND_ASSET_PATH}`,
      url: `${FRONTEND_URL}${FRONTEND_ASSET_PATH}`,
    },
  ];

  /** @type {{ label: string, url: string, httpCode: number }[]} */
  const rows = [];
  for (const t of tests) {
    const code = await getStatusCode(t.url);
    rows.push({ label: t.label, url: t.url, httpCode: code });
  }
  const ok = rows.every((r) => r.httpCode === 200);
  return { ok, rows };
}

/**
 * @param {{ label: string, url: string, httpCode: number }[]} rows
 * @param {boolean} ok
 */
function buildMarkdownReport(rows, ok) {
  const ts = new Date().toISOString();
  const statusLine = ok ? '**Overall: PASS**' : '**Overall: FAIL**';
  const lines = [
    '# Release smoke report',
    '',
    `- **Time (UTC):** ${ts}`,
    `- **Frontend base:** \`${FRONTEND_URL}\``,
    `- **Backend base:** \`${BACKEND_URL}\``,
    `- ${statusLine}`,
    '',
    '| Check | URL | Result |',
    '| --- | --- | --- |',
  ];
  for (const r of rows) {
    const pass = r.httpCode === 200;
    const result =
      r.httpCode === 0 ? 'FAIL (unreachable)' : pass ? 'PASS (200)' : `FAIL (${r.httpCode})`;
    lines.push(`| ${r.label} | \`${r.url}\` | ${result} |`);
  }
  lines.push('');
  lines.push('### Rerun locally');
  lines.push('');
  lines.push('```bash');
  lines.push(
    `FRONTEND_URL="${FRONTEND_URL}" BACKEND_URL="${BACKEND_URL}" \\\n` +
      `  BACKEND_HEALTH_PATH="${BACKEND_HEALTH_PATH}" BACKEND_YIELDS_PATH="${BACKEND_YIELDS_PATH}" \\\n` +
      `  FRONTEND_ASSET_PATH="${FRONTEND_ASSET_PATH}" \\\n` +
      `  node scripts/smoke-test.js --report --markdown`,
  );
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/**
 * Report mode: run all checks, print human log + optional markdown file.
 * @param {{ markdownOut: string | null }} opts
 */
async function runSmokeReport(opts) {
  console.log('----------------------------------------');
  console.log('StellarYield Smoke Test (report mode — all checks)');
  console.log('----------------------------------------');
  console.log(`Target Frontend: ${FRONTEND_URL}`);
  console.log(`Target Backend:  ${BACKEND_URL}`);
  console.log('----------------------------------------');

  const { ok, rows } = await collectSmokeResults();
  const md = buildMarkdownReport(rows, ok);

  for (const r of rows) {
    const pass = r.httpCode === 200;
    if (pass) {
      console.log(`[PASS] ${r.label} (200)`);
    } else if (r.httpCode === 0) {
      console.log(`[FAIL] ${r.label} (unreachable)`);
      console.log(`   URL: ${r.url}`);
    } else {
      console.log(`[FAIL] ${r.label} (${r.httpCode})`);
      console.log(`   URL: ${r.url}`);
    }
  }

  console.log('');
  console.log('----------------------------------------');
  console.log(ok ? 'All smoke tests passed.' : 'One or more smoke tests failed.');
  console.log('----------------------------------------');

  if (opts.markdownOut) {
    fs.writeFileSync(opts.markdownOut, md, 'utf8');
  }

  console.log('');
  console.log(md);

  process.exit(ok ? 0 : 1);
}

/**
 * Main smoke test function (fail-fast; default)
 */
async function runSmokeTest() {
  console.log('----------------------------------------');
  console.log('StellarYield Smoke Test');
  console.log('----------------------------------------');
  console.log(`Target Frontend: ${FRONTEND_URL}`);
  console.log(`Target Backend:  ${BACKEND_URL}`);
  console.log('----------------------------------------');

  const tests = [
    {
      step: '[1/5] Checking backend health...',
      label: `Backend ${BACKEND_HEALTH_PATH}`,
      url: `${BACKEND_URL}${BACKEND_HEALTH_PATH}`,
    },
    {
      step: '[2/5] Checking backend readiness...',
      label: `Backend readiness endpoint`,
      url: `${BACKEND_URL}${BACKEND_READINESS_PATH}`,
    },
    {
      step: '[3/5] Checking backend yield endpoint...',
      label: `Backend ${BACKEND_YIELDS_PATH}`,
      url: `${BACKEND_URL}${BACKEND_YIELDS_PATH}`,
    },
    {
      step: '[4/5] Checking frontend root...',
      label: 'Frontend /',
      url: `${FRONTEND_URL}/`,
    },
    {
      step: '[5/5] Checking frontend static asset...',
      label: `Frontend ${FRONTEND_ASSET_PATH}`,
      url: `${FRONTEND_URL}${FRONTEND_ASSET_PATH}`,
    },
  ];

  for (const test of tests) {
    console.log('');
    console.log(test.step);
    const passed = await expect200(test.label, test.url);
    if (!passed) {
      process.exit(1);
    }
  }

  console.log('');
  console.log('----------------------------------------');
  console.log('All smoke tests passed.');
  console.log('----------------------------------------');
}

// Run the smoke test
if (require.main === module) {
  const { flags, opts } = parseArgs(process.argv.slice(2));

  if (flags.has('report')) {
    runSmokeReport(opts).catch((error) => {
      console.error('Smoke test failed with error:', error);
      process.exit(1);
    });
  } else {
    runSmokeTest().catch((error) => {
      console.error('Smoke test failed with error:', error);
      process.exit(1);
    });
  }
}

module.exports = { runSmokeTest, runSmokeReport, getStatusCode, expect200, collectSmokeResults, buildMarkdownReport };
