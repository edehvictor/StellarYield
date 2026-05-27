import { describe, it, expect } from 'vitest';
import { diffRegistries, Registry } from '../registryDiff';

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

    // Testnet: zap added, governance removed, strategy changed
    const tn = diff.testnet.changes;
    const zapChange = tn.find(c => c.name === 'zap');
    const govChange = tn.find(c => c.name === 'governance');
    const stratChange = tn.find(c => c.name === 'strategy');

    expect(zapChange?.type).toBe('added');
    expect(govChange?.type).toBe('removed');
    expect(stratChange?.type).toBe('changed');

    // Mainnet: vault changed, emissionController removed
    const mn = diff.mainnet.changes;
    const vaultMain = mn.find(c => c.name === 'vault');
    const emcMain = mn.find(c => c.name === 'emissionController');
    expect(vaultMain?.type).toBe('changed');
    expect(emcMain?.type).toBe('removed');

    // Local: vault added
    const ln = diff.local.changes;
    const vaultLocal = ln.find(c => c.name === 'vault');
    expect(vaultLocal?.type).toBe('added');
  });
});
