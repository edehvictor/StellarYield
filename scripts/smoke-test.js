#!/usr/bin/env node

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Configuration from environment variables
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_HEALTH_PATH = process.env.BACKEND_HEALTH_PATH || '/api/health';
const BACKEND_YIELDS_PATH = process.env.BACKEND_YIELDS_PATH || '/api/yields';
const FRONTEND_ASSET_PATH = process.env.FRONTEND_ASSET_PATH || '/favicon.svg';

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
    } catch (error) {
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
  } else {
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
}

/**
 * Main smoke test function
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
      step: '[1/4] Checking backend health...',
      label: `Backend ${BACKEND_HEALTH_PATH}`,
      url: `${BACKEND_URL}${BACKEND_HEALTH_PATH}`
    },
    {
      step: '[2/4] Checking backend yield endpoint...',
      label: `Backend ${BACKEND_YIELDS_PATH}`,
      url: `${BACKEND_URL}${BACKEND_YIELDS_PATH}`
    },
    {
      step: '[3/4] Checking frontend root...',
      label: 'Frontend /',
      url: `${FRONTEND_URL}/`
    },
    {
      step: '[4/4] Checking frontend static asset...',
      label: `Frontend ${FRONTEND_ASSET_PATH}`,
      url: `${FRONTEND_URL}${FRONTEND_ASSET_PATH}`
    }
  ];

  let allPassed = true;

  for (const test of tests) {
    console.log('');
    console.log(test.step);
    const passed = await expect200(test.label, test.url);
    if (!passed) {
      allPassed = false;
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
  runSmokeTest().catch((error) => {
    console.error('Smoke test failed with error:', error);
    process.exit(1);
  });
}

module.exports = { runSmokeTest, getStatusCode, expect200 };