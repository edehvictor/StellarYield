import { describe, it, expect } from 'vitest';
import { diffRegistries, annotateRegistryDiff, type Registry } from '../registryDiff';

// Helpers
function emptyNet(): Record<string, string> {
  return { vault: '', zap: '', token: '', governance: '', strategy: '', emissionController: '', liquidStaking: '', stableswap: '' };
}

function fullNet(overrides: Record<string, string> = {}): Record<string, string> {
  return { vault: 'VA', zap: 'ZA', token: 'TA', governance: 'GA', strategy: 'SA', emissionController: 'EA', liquidStaking: 'LA', stableswap: 'SS', ...overrides };
}

describe('diffRegistries', () => {
  it('detects added, removed and changed entries', () => {
    const oldReg: Registry = {
      testnet: { vault: 'A', zap: '', token: 'T1', governance: 'G1', strategy: 'S1', emissionController: '', liquidStaking: '', stableswap: '' },
      mainnet: { vault: 'MVA', zap: 'MZ', token: 'MT', governance: 'MG', strategy: 'MS', emissionController: 'ME', liquidStaking: '', stableswap: '' },
      local: { vault: '', zap: '', token: '', governance: '', strategy: '', emissionController: '', liquidStaking: '', stableswap: '' },
    };

    const newReg: Registry = {
      testnet: { vault: 'A', zap: 'Z_NEW', token: 'T1', governance: '', strategy: 'S1_UPDATED', emissionController: '', liquidStaking: '', stableswap: '' },
      mainnet: { vault: 'MVA_NEW', zap: 'MZ', token: 'MT', governance: 'MG', strategy: 'MS', emissionController: '', liquidStaking: '', stableswap: '' },
      local: { vault: 'L_V', zap: '', token: '', governance: '', strategy: '', emissionController: '', liquidStaking: '', stableswap: '' },
    };

    const diff = diffRegistries(oldReg, newReg);

    const tn = diff.testnet.changes;
    expect(tn.find(c => c.name === 'zap')?.type).toBe('added');
    expect(tn.find(c => c.name === 'governance')?.type).toBe('removed');
    expect(tn.find(c => c.name === 'strategy')?.type).toBe('changed');

    const mn = diff.mainnet.changes;
    expect(mn.find(c => c.name === 'vault')?.type).toBe('changed');
    expect(mn.find(c => c.name === 'emissionController')?.type).toBe('removed');

    expect(diff.local.changes.find(c => c.name === 'vault')?.type).toBe('added');
  });

  it('reports unchanged entries when registries are identical', () => {
    const reg: Registry = {
      testnet: fullNet() as any,
      mainnet: fullNet() as any,
      local: emptyNet() as any,
    };
    const diff = diffRegistries(reg, reg);
    for (const change of diff.testnet.changes) {
      expect(change.type).toBe('unchanged');
    }
    expect(diff.testnet.missing).toHaveLength(0);
  });

  it('sets oldAddress to null for added entries', () => {
    const oldReg: Registry = { testnet: emptyNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: { ...emptyNet(), vault: 'NEW_V' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const diff = diffRegistries(oldReg, newReg);
    const added = diff.testnet.changes.find(c => c.name === 'vault');
    expect(added?.type).toBe('added');
    expect(added?.oldAddress).toBeNull();
    expect(added?.newAddress).toBe('NEW_V');
  });

  it('sets newAddress to null for removed entries', () => {
    const oldReg: Registry = { testnet: { ...emptyNet(), vault: 'OLD_V' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: emptyNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const diff = diffRegistries(oldReg, newReg);
    const removed = diff.testnet.changes.find(c => c.name === 'vault');
    expect(removed?.type).toBe('removed');
    expect(removed?.newAddress).toBeNull();
    expect(removed?.oldAddress).toBe('OLD_V');
  });

  it('populates missing list for entries absent from new registry', () => {
    const oldReg: Registry = { testnet: fullNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: emptyNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const diff = diffRegistries(oldReg, newReg);
    expect(diff.testnet.missing.length).toBeGreaterThan(0);
    expect(diff.testnet.missing).toContain('vault');
  });

  it('handles local network drift independently from testnet and mainnet', () => {
    const oldReg: Registry = {
      testnet: fullNet() as any,
      mainnet: fullNet() as any,
      local: emptyNet() as any,
    };
    const newReg: Registry = {
      testnet: fullNet() as any,
      mainnet: fullNet() as any,
      local: { ...emptyNet(), vault: 'LOCAL_V' } as any,
    };
    const diff = diffRegistries(oldReg, newReg);
    expect(diff.testnet.changes.every(c => c.type === 'unchanged')).toBe(true);
    expect(diff.local.changes.find(c => c.name === 'vault')?.type).toBe('added');
  });
});

describe('annotateRegistryDiff', () => {
  it('returns one annotation per network in testnet → mainnet → local order', () => {
    const reg: Registry = { testnet: emptyNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const annotations = annotateRegistryDiff(diffRegistries(reg, reg));
    expect(annotations).toHaveLength(3);
    expect(annotations[0]?.network).toBe('testnet');
    expect(annotations[1]?.network).toBe('mainnet');
    expect(annotations[2]?.network).toBe('local');
  });

  it('reports no drift when registries are identical', () => {
    const reg: Registry = { testnet: fullNet() as any, mainnet: fullNet() as any, local: fullNet() as any };
    const annotations = annotateRegistryDiff(diffRegistries(reg, reg));
    for (const ann of annotations) {
      expect(ann.hasDrift).toBe(false);
      expect(ann.lines).toHaveLength(0);
      expect(ann.summary).toContain('no drift');
    }
  });

  it('sets hasDrift=true and includes [ADDED] line for a new contract ID', () => {
    const oldReg: Registry = { testnet: emptyNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: { ...emptyNet(), vault: 'V_NEW' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const [tn] = annotateRegistryDiff(diffRegistries(oldReg, newReg));
    expect(tn?.hasDrift).toBe(true);
    expect(tn?.lines.some(l => l.includes('[ADDED]') && l.includes('vault'))).toBe(true);
    expect(tn?.summary).toContain('testnet');
  });

  it('includes [REMOVED] line when a contract is dropped', () => {
    const oldReg: Registry = { testnet: { ...emptyNet(), zap: 'ZAP_ID' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: emptyNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const [tn] = annotateRegistryDiff(diffRegistries(oldReg, newReg));
    expect(tn?.lines.some(l => l.includes('[REMOVED]') && l.includes('zap'))).toBe(true);
  });

  it('includes [CHANGED] line when an address is updated', () => {
    const oldReg: Registry = { testnet: { ...emptyNet(), vault: 'OLD' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: { ...emptyNet(), vault: 'NEW' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const [tn] = annotateRegistryDiff(diffRegistries(oldReg, newReg));
    expect(tn?.lines.some(l => l.includes('[CHANGED]') && l.includes('OLD') && l.includes('NEW'))).toBe(true);
  });

  it('includes [REMOVED] line (with MISSING note) when contracts drop out of new registry', () => {
    const oldReg: Registry = { testnet: fullNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: emptyNet() as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const [tn] = annotateRegistryDiff(diffRegistries(oldReg, newReg));
    expect(tn?.lines.some(l => l.includes('[REMOVED]') && l.includes('MISSING'))).toBe(true);
  });

  it('annotates mainnet drift independently of testnet', () => {
    const oldReg: Registry = { testnet: fullNet() as any, mainnet: { ...emptyNet(), vault: 'MV_OLD' } as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: fullNet() as any, mainnet: { ...emptyNet(), vault: 'MV_NEW' } as any, local: emptyNet() as any };
    const annotations = annotateRegistryDiff(diffRegistries(oldReg, newReg));
    const tn = annotations.find(a => a.network === 'testnet')!;
    const mn = annotations.find(a => a.network === 'mainnet')!;
    expect(tn.hasDrift).toBe(false);
    expect(mn.hasDrift).toBe(true);
    expect(mn.lines.some(l => l.includes('[CHANGED]') && l.includes('vault'))).toBe(true);
  });

  it('summary includes change count when drift is present', () => {
    const oldReg: Registry = { testnet: { ...emptyNet(), vault: 'V1', zap: 'Z1' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const newReg: Registry = { testnet: { ...emptyNet(), vault: 'V2', zap: 'Z2' } as any, mainnet: emptyNet() as any, local: emptyNet() as any };
    const [tn] = annotateRegistryDiff(diffRegistries(oldReg, newReg));
    expect(tn?.summary).toMatch(/\d+ change/);
  });
});
