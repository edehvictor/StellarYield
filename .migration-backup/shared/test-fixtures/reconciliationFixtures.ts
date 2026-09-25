export interface ReconciliationFixture {
  description: string;
  input: {
    positions: { asset: string; expected: number }[];
    balances: { provider: string; asset: string; balance?: number }[];
  };
  expectedOutput: {
    rowCount: number;
    rows: {
      asset: string;
      severity: 'matched' | 'small' | 'material' | 'critical' | 'unavailable';
      deltaSign: 'positive' | 'negative' | 'zero' | 'null';
    }[];
  };
}

export const RECONCILIATION_FIXTURES: ReconciliationFixture[] = [
  {
    description: 'Perfectly matched single-asset portfolio',
    input: {
      positions: [{ asset: 'USDC', expected: 10_000 }],
      balances: [{ provider: 'Blend', asset: 'USDC', balance: 10_000 }],
    },
    expectedOutput: {
      rowCount: 1,
      rows: [{ asset: 'USDC', severity: 'matched', deltaSign: 'zero' }],
    },
  },
  {
    description: 'Small drift within 1-5% band',
    input: {
      positions: [{ asset: 'USDC', expected: 10_000 }],
      balances: [{ provider: 'Blend', asset: 'USDC', balance: 9_800 }],
    },
    expectedOutput: {
      rowCount: 1,
      rows: [{ asset: 'USDC', severity: 'small', deltaSign: 'negative' }],
    },
  },
  {
    description: 'Material drift within 5-15% band',
    input: {
      positions: [{ asset: 'XLM', expected: 50_000 }],
      balances: [{ provider: 'AMM', asset: 'XLM', balance: 44_000 }],
    },
    expectedOutput: {
      rowCount: 1,
      rows: [{ asset: 'XLM', severity: 'material', deltaSign: 'negative' }],
    },
  },
  {
    description: 'Critical drift exceeding 15%',
    input: {
      positions: [{ asset: 'ETH', expected: 100 }],
      balances: [{ provider: 'Bridge', asset: 'ETH', balance: 80 }],
    },
    expectedOutput: {
      rowCount: 1,
      rows: [{ asset: 'ETH', severity: 'critical', deltaSign: 'negative' }],
    },
  },
  {
    description: 'Provider unavailable (no balance data)',
    input: {
      positions: [{ asset: 'BTC', expected: 5 }],
      balances: [],
    },
    expectedOutput: {
      rowCount: 1,
      rows: [{ asset: 'BTC', severity: 'unavailable', deltaSign: 'null' }],
    },
  },
  {
    description: 'Multi-asset portfolio with mixed severities',
    input: {
      positions: [
        { asset: 'USDC', expected: 10_000 },
        { asset: 'XLM', expected: 20_000 },
        { asset: 'ETH', expected: 50 },
      ],
      balances: [
        { provider: 'Blend', asset: 'USDC', balance: 10_000 },
        { provider: 'AMM', asset: 'XLM', balance: 18_000 },
        { provider: 'Bridge', asset: 'ETH', balance: 40 },
      ],
    },
    expectedOutput: {
      rowCount: 3,
      rows: [
        { asset: 'USDC', severity: 'matched', deltaSign: 'zero' },
        { asset: 'XLM', severity: 'material', deltaSign: 'negative' },
        { asset: 'ETH', severity: 'critical', deltaSign: 'negative' },
      ],
    },
  },
  {
    description: 'Positive drift (observed > expected)',
    input: {
      positions: [{ asset: 'USDC', expected: 10_000 }],
      balances: [{ provider: 'Blend', asset: 'USDC', balance: 11_600 }],
    },
    expectedOutput: {
      rowCount: 1,
      rows: [{ asset: 'USDC', severity: 'critical', deltaSign: 'positive' }],
    },
  },
  {
    description: 'Multiple providers aggregated for one asset',
    input: {
      positions: [{ asset: 'USDC', expected: 10_000 }],
      balances: [
        { provider: 'Blend-A', asset: 'USDC', balance: 5_000 },
        { provider: 'Blend-B', asset: 'USDC', balance: 5_000 },
      ],
    },
    expectedOutput: {
      rowCount: 1,
      rows: [{ asset: 'USDC', severity: 'matched', deltaSign: 'zero' }],
    },
  },
];

export interface VarianceExplanation {
  asset: string;
  expected: number;
  observed: number | null;
  delta: number | null;
  deltaPct: number | null;
  severity: string;
  explanation: string;
}

export function explainVariance(row: {
  asset: string;
  expected: number;
  observed: number | null;
  delta: number | null;
  deltaPct: number | null;
  severity: string;
}): VarianceExplanation {
  let explanation: string;
  if (row.severity === 'unavailable') {
    explanation = `No balance data available for ${row.asset}; provider may be offline.`;
  } else if (row.severity === 'matched') {
    explanation = `${row.asset} balance matches expected within tolerance.`;
  } else if (row.severity === 'small') {
    explanation = `${row.asset} shows minor drift of ${row.deltaPct !== null ? (row.deltaPct * 100).toFixed(2) : 'N/A'}%; likely rounding or pending settlement.`;
  } else if (row.severity === 'material') {
    explanation = `${row.asset} has material variance of ${row.deltaPct !== null ? (row.deltaPct * 100).toFixed(2) : 'N/A'}%; investigate rebalance timing or yield accrual.`;
  } else {
    explanation = `${row.asset} has critical variance of ${row.deltaPct !== null ? (row.deltaPct * 100).toFixed(2) : 'N/A'}%; immediate investigation required.`;
  }
  return { ...row, explanation };
}

export function validateReconciliationResult(
  fixture: ReconciliationFixture,
  rows: { asset: string; severity: string; delta: number | null }[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (rows.length !== fixture.expectedOutput.rowCount) {
    errors.push(`Expected ${fixture.expectedOutput.rowCount} rows, got ${rows.length}`);
  }

  for (const expected of fixture.expectedOutput.rows) {
    const row = rows.find((r) => r.asset === expected.asset);
    if (!row) {
      errors.push(`Missing row for asset ${expected.asset}`);
      continue;
    }
    if (row.severity !== expected.severity) {
      errors.push(`${expected.asset}: expected severity "${expected.severity}", got "${row.severity}"`);
    }
    if (expected.deltaSign === 'null' && row.delta !== null) {
      errors.push(`${expected.asset}: expected null delta, got ${row.delta}`);
    }
    if (expected.deltaSign === 'zero' && row.delta !== 0) {
      errors.push(`${expected.asset}: expected zero delta, got ${row.delta}`);
    }
    if (expected.deltaSign === 'positive' && (row.delta === null || row.delta <= 0)) {
      errors.push(`${expected.asset}: expected positive delta, got ${row.delta}`);
    }
    if (expected.deltaSign === 'negative' && (row.delta === null || row.delta >= 0)) {
      errors.push(`${expected.asset}: expected negative delta, got ${row.delta}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
