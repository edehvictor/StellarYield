import {
  reconcilePortfolio,
  reconcileReceipts,
  getReceiptsByStatus,
  resetReceiptStore,
  type DepositReceipt,
  type IndexedVaultDepositEvent,
} from '../portfolioReconcileService';

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

describe('deposit receipt reconciliation', () => {
  const makeReceipt = (overrides: Partial<DepositReceipt> = {}): DepositReceipt => ({
    txHash: 'abc123',
    walletAddress: 'GAAA...',
    vaultId: 'vault-1',
    assetId: 'USDC',
    amount: 1000,
    submittedAt: '2024-01-15T10:00:00Z',
    status: 'pending',
    ...overrides,
  });

  const makeEvent = (overrides: Partial<IndexedVaultDepositEvent> = {}): IndexedVaultDepositEvent => ({
    eventId: 'evt_001',
    txHash: 'abc123',
    vaultId: 'vault-1',
    assetId: 'USDC',
    amount: 1000,
    sharesAssigned: 950,
    ledgerSequence: 100,
    processedAt: '2024-01-15T10:01:00Z',
    ...overrides,
  });

  test('confirms receipt when event matches', () => {
    const receipts = [makeReceipt()];
    const events = [makeEvent()];
    const result = reconcileReceipts(receipts, events);
    expect(result[0].status).toBe('confirmed');
    expect(result[0].indexedEventId).toBe('evt_001');
    expect(result[0].sharesAssigned).toBe(950);
  });

  test('keeps receipt pending when no matching event exists', () => {
    const receipts = [makeReceipt()];
    const events: IndexedVaultDepositEvent[] = [];
    const result = reconcileReceipts(receipts, events);
    expect(result[0].status).toBe('pending');
    expect(result[0].indexedEventId).toBeUndefined();
  });

  test('detects duplicate events as mismatched', () => {
    const receipts = [makeReceipt()];
    const events = [
      makeEvent({ eventId: 'evt_001' }),
      makeEvent({ eventId: 'evt_002' }),
    ];
    const result = reconcileReceipts(receipts, events);
    expect(result[0].status).toBe('mismatched');
    expect(result[0].mismatchReason).toBe('duplicate_events');
  });

  test('detects amount mismatch as mismatched', () => {
    const receipts = [makeReceipt({ amount: 1000 })];
    const events = [makeEvent({ amount: 999 })];
    const result = reconcileReceipts(receipts, events);
    expect(result[0].status).toBe('mismatched');
    expect(result[0].mismatchReason).toBe('amount_mismatch');
  });

  test('handles delayed indexer confirmation', () => {
    const receipts = [makeReceipt({ submittedAt: '2024-01-15T10:00:00Z' })];
    const events = [makeEvent({ processedAt: '2024-01-15T10:05:00Z' })];
    const result = reconcileReceipts(receipts, events);
    expect(result[0].status).toBe('confirmed');
    expect(result[0].confirmedAt).toBe('2024-01-15T10:05:00Z');
  });

  test('filters receipts by status', () => {
    const receipts = [
      makeReceipt({ txHash: 'tx1', status: 'pending' }),
      makeReceipt({ txHash: 'tx2', status: 'confirmed' }),
      makeReceipt({ txHash: 'tx3', status: 'mismatched' }),
    ];
    expect(getReceiptsByStatus(receipts, 'pending')).toHaveLength(1);
    expect(getReceiptsByStatus(receipts, 'confirmed')).toHaveLength(1);
    expect(getReceiptsByStatus(receipts, 'mismatched')).toHaveLength(1);
  });

  test('handles multiple receipts with mixed outcomes', () => {
    const receipts = [
      makeReceipt({ txHash: 'tx1', amount: 1000 }),
      makeReceipt({ txHash: 'tx2', amount: 500 }),
      makeReceipt({ txHash: 'tx3', amount: 200 }),
    ];
    const events = [
      makeEvent({ txHash: 'tx1', amount: 1000 }),
      makeEvent({ txHash: 'tx2', amount: 499 }),
    ];
    const result = reconcileReceipts(receipts, events);
    expect(result[0].status).toBe('confirmed');
    expect(result[1].status).toBe('mismatched');
    expect(result[2].status).toBe('pending');
  });
});
