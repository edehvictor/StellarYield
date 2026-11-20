import { describe, it, expect } from 'vitest';

/**
 * Deployment Config Validation Tests
 *
 * Tests the early-warning system for missing required public API settings.
 */

// Simulated validation logic (extracted for testing)
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

function validateConfig(env: Record<string, string | undefined>): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    missing: [],
    invalid: [],
    warnings: [],
  };

  // Check required settings
  for (const setting of REQUIRED_SETTINGS) {
    const value = env[setting.name];

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
    const value = env[setting.name];
    if (!value) {
      result.warnings.push(`${setting.name}: ${setting.description}`);
    }
  }

  return result;
}

describe('Deployment Configuration Validation', () => {
  describe('Required Settings', () => {
    it('should pass when all required settings are present and valid', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
      expect(result.invalid).toHaveLength(0);
    });

    it('should fail when VITE_SOROBAN_RPC_URL is missing', () => {
      const mockEnv = {
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('VITE_SOROBAN_RPC_URL');
    });

    it('should fail when VITE_NETWORK_PASSPHRASE is missing', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('VITE_NETWORK_PASSPHRASE');
    });

    it('should fail when VITE_CONTRACT_ID is missing', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('VITE_CONTRACT_ID');
    });

    it('should fail when all required settings are missing', () => {
      const mockEnv = {};

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(false);
      expect(result.missing).toHaveLength(3);
      expect(result.missing).toContain('VITE_SOROBAN_RPC_URL');
      expect(result.missing).toContain('VITE_NETWORK_PASSPHRASE');
      expect(result.missing).toContain('VITE_CONTRACT_ID');
    });

    it('should reject invalid RPC URLs', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'not-a-url',
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(false);
      expect(result.invalid.length).toBeGreaterThan(0);
    });

    it('should accept http:// URLs for local development', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'http://localhost:8000',
        VITE_NETWORK_PASSPHRASE: 'Standalone Network ; February 2021',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(true);
      expect(result.invalid).toHaveLength(0);
    });

    it('should treat empty strings as missing', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_NETWORK_PASSPHRASE: '',
        VITE_CONTRACT_ID: '',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('VITE_NETWORK_PASSPHRASE');
      expect(result.missing).toContain('VITE_CONTRACT_ID');
    });
  });

  describe('Recommended Settings', () => {
    it('should warn when optional API_BASE_URL is missing', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should not warn when recommended settings are present', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
        VITE_API_BASE_URL: 'https://api.stellaryield.com',
        VITE_ZAP_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
        VITE_VESTING_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('Build Decision', () => {
    it('should indicate build should fail when required settings are missing', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        // Missing VITE_CONTRACT_ID
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(false);
    });

    it('should indicate build can proceed when only warnings exist', () => {
      const mockEnv = {
        VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        VITE_CONTRACT_ID: 'CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA',
      };

      const result = validateConfig(mockEnv);

      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Setting Documentation', () => {
    it('should have descriptions for all required settings', () => {
      REQUIRED_SETTINGS.forEach((setting) => {
        expect(setting.description).toBeTruthy();
        expect(setting.description.length).toBeGreaterThan(0);
      });
    });

    it('should have descriptions for all recommended settings', () => {
      RECOMMENDED_SETTINGS.forEach((setting) => {
        expect(setting.description).toBeTruthy();
        expect(setting.description.length).toBeGreaterThan(0);
      });
    });

    it('should document VITE_SOROBAN_RPC_URL', () => {
      const setting = REQUIRED_SETTINGS.find(
        (s) => s.name === 'VITE_SOROBAN_RPC_URL',
      );
      expect(setting).toBeDefined();
      expect(setting?.description).toContain('Soroban RPC');
    });

    it('should document VITE_NETWORK_PASSPHRASE', () => {
      const setting = REQUIRED_SETTINGS.find(
        (s) => s.name === 'VITE_NETWORK_PASSPHRASE',
      );
      expect(setting).toBeDefined();
      expect(setting?.description).toContain('network passphrase');
    });

    it('should document VITE_CONTRACT_ID', () => {
      const setting = REQUIRED_SETTINGS.find((s) => s.name === 'VITE_CONTRACT_ID');
      expect(setting).toBeDefined();
      expect(setting?.description).toContain('Vault');
    });
  });
});
