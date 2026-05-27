import { reconcilePortfolio } from '../portfolioReconcileService';

describe('reconcilePortfolio', () => {
  test('matched case', () => {
    const positions = [{ asset: 'USDC', expected: 1000 }];
    const balances = [{ provider: 'P1', asset: 'USDC', balance: 1000 }];
    const rows = reconcilePortfolio(positions, balances);
    expect(rows[0].severity).toBe('matched');
    expect(rows[0].delta).toBe(0);
  });

  test('drifted case', () => {
    const positions = [{ asset: 'USDC', expected: 1000 }];
    const balances = [{ provider: 'P1', asset: 'USDC', balance: 940 }];
    const rows = reconcilePortfolio(positions, balances);
    expect(rows[0].severity).toBe('material');
    expect(rows[0].delta).toBe(-60);
  });

  test('unavailable provider case', () => {
    const positions = [{ asset: 'USDC', expected: 1000 }];
    const balances: any[] = [];
    const rows = reconcilePortfolio(positions, balances);
    expect(rows[0].severity).toBe('unavailable');
    expect(rows[0].observed).toBeNull();
  });
});
