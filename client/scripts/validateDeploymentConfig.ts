#!/usr/bin/env node

/**
 * Deployment Configuration Validator
 *
 * Ensures required public API settings are configured before build finalization.
 * Runs as part of the build process to fail early with clear error messages.
 *
 * Exit codes:
 *   0 = Success, all required settings present
 *   1 = Validation failed, missing or invalid settings
 */

const REQUIRED_SETTINGS = [
  {
    name: 'VITE_SOROBAN_RPC_URL',
    description: 'Soroban RPC endpoint (e.g., https://soroban-testnet.stellar.org)',
    validator: (value: string) => /^https?:\/\/.+/.test(value),
  },
  {
    name: 'VITE_NETWORK_PASSPHRASE',
    description: 'Stellar network passphrase (e.g., "Test SDF Network ; September 2015")',
    validator: (value: string) => value.length > 0,
  },
  {
    name: 'VITE_CONTRACT_ID',
    description: 'Main Vault contract ID (Soroban contract address)',
    validator: (value: string) => value.length > 0,
  },
];

/**
 * Optional but recommended settings for production deployments.
 * Missing these should warn but not fail the build.
 */
const RECOMMENDED_SETTINGS = [
  {
    name: 'VITE_API_BASE_URL',
    description: 'Backend API base URL (e.g., https://api.stellaryield.com)',
  },
  {
    name: 'VITE_ZAP_CONTRACT_ID',
    description: 'ZAP contract ID (for swap functionality)',
  },
  {
    name: 'VITE_VESTING_CONTRACT_ID',
    description: 'Vesting contract ID (for vesting features)',
  },
];

interface ValidationResult {
  valid: boolean;
  missing: string[];
  invalid: string[];
  warnings: string[];
}

function validateConfig(): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    missing: [],
    invalid: [],
    warnings: [],
  };

  // Check required settings
  for (const setting of REQUIRED_SETTINGS) {
    const value = process.env[setting.name];

    if (!value) {
      result.missing.push(setting.name);
      result.valid = false;
      continue;
    }

    if (!setting.validator(value)) {
      result.invalid.push(
        `${setting.name}: Invalid format. Expected: ${setting.description}`,
      );
      result.valid = false;
    }
  }

  // Check recommended settings (warnings only)
  for (const setting of RECOMMENDED_SETTINGS) {
    const value = process.env[setting.name];
    if (!value) {
      result.warnings.push(`${setting.name}: ${setting.description}`);
    }
  }

  return result;
}

function printValidationResults(result: ValidationResult): void {
  console.log('\n🔍 Deployment Configuration Validation\n');

  if (result.valid && result.warnings.length === 0) {
    console.log('✅ All required public API settings are configured.\n');
    return;
  }

  if (result.missing.length > 0) {
    console.error('❌ FATAL: Missing required environment settings:\n');
    result.missing.forEach((name) => {
      const setting = REQUIRED_SETTINGS.find((s) => s.name === name);
      console.error(`   • ${name}`);
      console.error(`     ${setting?.description}\n`);
    });
  }

  if (result.invalid.length > 0) {
    console.error('❌ FATAL: Invalid environment settings:\n');
    result.invalid.forEach((msg) => {
      console.error(`   • ${msg}\n`);
    });
  }

  if (result.warnings.length > 0 && !result.missing.length && !result.invalid.length) {
    console.warn('⚠️  Recommended public API settings not configured:\n');
    result.warnings.forEach((msg) => {
      console.warn(`   • ${msg}\n`);
    });
    console.warn(
      'Note: Build will proceed, but some features may not work as expected.\n',
    );
  }

  if (!result.valid) {
    console.error(
      'Build cannot proceed. Set the missing environment variables and try again.\n',
    );
    console.error('For guidance, see: docs/frontend-env-reference.md\n');
  }
}

function main(): void {
  const result = validateConfig();
  printValidationResults(result);

  if (!result.valid) {
    process.exit(1);
  }

  process.exit(0);
}

main();
