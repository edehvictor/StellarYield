/**
 * Tests for SDK contract registry graceful fallback (#1116).
 *
 * Covers:
 *   - createContractRegistryLoader with null registry falls back to safe defaults
 *   - createContractRegistryLoader with undefined registry falls back
 *   - createContractRegistryLoader with malformed (array) registry falls back
 *   - createContractRegistryLoader with missing network keys falls back
 *   - Loader warnings are populated when fallback is used
 *   - Loader usedFallback flag is true on fallback
 *   - resolve still works with fallback registry (returns empty string)
 *   - requireContractId throws descriptive error on fallback registry
 *   - resolveAll returns valid shape on fallback registry
 */

import { describe, it, expect } from 'vitest';
import {
  createContractRegistryLoader,
  type ContractRegistry,
  type NetworkName,
  type ContractName,
} from '../src/contractRegistry';

describe('ContractRegistryLoader fallback', () => {
  it('creates loader with null registry and uses safe defaults', () => {
    const loader = createContractRegistryLoader(null as unknown as ContractRegistry);
    expect(loader.usedFallback).toBe(true);
    expect(loader.warnings.length).toBeGreaterThan(0);
    expect(loader.warnings[0]?.code).toBe('fallback_used');
  });

  it('creates loader with undefined registry', () => {
    const loader = createContractRegistryLoader(undefined as unknown as ContractRegistry);
    expect(loader.usedFallback).toBe(true);
    expect(loader.warnings.some((w) => w.code === 'fallback_used')).toBe(true);
  });

  it('creates loader with array (invalid type) registry', () => {
    const loader = createContractRegistryLoader([1, 2, 3] as unknown as ContractRegistry);
    expect(loader.usedFallback).toBe(true);
    expect(loader.warnings.some((w) => w.message.includes('invalid structure'))).toBe(true);
  });

  it('creates loader with object missing all network keys', () => {
    const loader = createContractRegistryLoader({ foo: 'bar' } as unknown as ContractRegistry);
    expect(loader.usedFallback).toBe(true);
    expect(loader.warnings.some((w) => w.message.includes('invalid structure'))).toBe(true);
  });

  it('returns correct shape on valid registry', () => {
    const validRegistry: ContractRegistry = {
      testnet: { vault: 'V1' },
      mainnet: { vault: 'V2' },
      local: {},
    };
    const loader = createContractRegistryLoader(validRegistry);
    expect(loader.usedFallback).toBe(false);
  });

  it('warns about empty networks in valid registry', () => {
    const partial: ContractRegistry = {
      testnet: { vault: 'VA' },
      mainnet: {},
      local: {},
    };
    const loader = createContractRegistryLoader(partial);
    // Should have warnings for mainnet and local being empty
    const emptyWarnings = loader.warnings.filter((w) => w.code === 'empty_registry');
    expect(emptyWarnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ContractRegistryLoader.resolve with fallback', () => {
  it('resolve returns empty contractId on fallback registry', () => {
    const loader = createContractRegistryLoader(null as unknown as ContractRegistry);
    const result = loader.resolve('vault', 'testnet');
    expect(result.contractId).toBe('');
    expect(result.resolvedFrom).toBe('none');
    expect(result.usedFallback).toBe(false);
  });

  it('resolveAll returns valid shape on fallback registry', () => {
    const loader = createContractRegistryLoader(null as unknown as ContractRegistry);
    const all = loader.resolveAll('testnet');
    expect(all).toHaveProperty('vault');
    expect(all).toHaveProperty('zap');
    expect(all).toHaveProperty('token');
    expect(all).toHaveProperty('governance');
    expect(all).toHaveProperty('strategy');
    expect(all).toHaveProperty('emissionController');
    expect(all).toHaveProperty('liquidStaking');
    expect(all).toHaveProperty('stableswap');
    expect(all).toHaveProperty('vesting');
  });

  it('requireContractId throws descriptive error on fallback registry', () => {
    const loader = createContractRegistryLoader(null as unknown as ContractRegistry);
    expect(() => loader.requireContractId('vault', 'testnet')).toThrow('Missing contract ID');
    expect(() => loader.requireContractId('vault', 'testnet')).toThrow('vault');
    expect(() => loader.requireContractId('vault', 'testnet')).toThrow('testnet');
  });

  it('override still works even on fallback registry', () => {
    const loader = createContractRegistryLoader(null as unknown as ContractRegistry, {
      vault: 'OVERRIDE_VAULT',
    });
    const result = loader.resolve('vault', 'testnet');
    expect(result.contractId).toBe('OVERRIDE_VAULT');
    expect(result.resolvedFrom).toBe('override');
  });

  it('local network falls back to testnet when testnet has data', () => {
    const registry: ContractRegistry = {
      testnet: { vault: 'TESTNET_V' },
      mainnet: {},
      local: {},
    };
    const loader = createContractRegistryLoader(registry);
    const result = loader.resolve('vault', 'local');
    expect(result.contractId).toBe('TESTNET_V');
    expect(result.usedFallback).toBe(true);
    expect(result.resolvedFrom).toBe('testnet');
  });
});
