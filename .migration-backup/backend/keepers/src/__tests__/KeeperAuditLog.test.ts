import fs from 'fs';
import os from 'os';
import path from 'path';
import { createKeeperAuditLog } from '../audit/KeeperAuditLog';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-audit-test-'));
}

describe('KeeperAuditLog', () => {
  let dir: string;
  let auditLog: ReturnType<typeof createKeeperAuditLog>;

  beforeEach(() => {
    dir = makeTempDir();
    auditLog = createKeeperAuditLog(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function appendSample(overrides: Partial<Parameters<typeof auditLog.appendDecision>[1]> = {}) {
    return auditLog.appendDecision('compound', {
      workerName: 'CompoundWorker',
      jobId: 'job-1',
      policyVersion: 'v1',
      contractId: 'CVAULT',
      method: 'harvest',
      inputs: { amount: '1000' },
      decision: 'invoke harvest on CVAULT',
      simulationResult: { minResourceFee: '100' },
      ...overrides,
    });
  }

  test('appends hash-chained records with an increasing seq', () => {
    const first = appendSample();
    const second = appendSample({ jobId: 'job-2' });

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(second.previousHash).toBe(first.hash);
  });

  test('verifyStreamIntegrity passes for an untouched stream', () => {
    appendSample();
    appendSample({ jobId: 'job-2' });

    const result = auditLog.verifyStreamIntegrity('compound');
    expect(result).toEqual({ isValid: true, brokenAtIndex: null });
  });

  test('detects tampering: mutating a historical record breaks verification', () => {
    appendSample();
    appendSample({ jobId: 'job-2' });

    const file = path.join(dir, 'compound.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const mutated = JSON.parse(lines[0]);
    mutated.decision = 'invoke a different method entirely';
    lines[0] = JSON.stringify(mutated);
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const result = auditLog.verifyStreamIntegrity('compound');
    expect(result.isValid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
    expect(result.reason).toBe('hash-mismatch');
  });

  test('detects reordering: swapping two records breaks the sequence chain', () => {
    appendSample();
    appendSample({ jobId: 'job-2' });
    appendSample({ jobId: 'job-3' });

    const file = path.join(dir, 'compound.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    [lines[0], lines[1]] = [lines[1], lines[0]];
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const result = auditLog.verifyStreamIntegrity('compound');
    expect(result.isValid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
  });

  test('detects a missing/deleted record as a sequence gap', () => {
    appendSample();
    appendSample({ jobId: 'job-2' });
    appendSample({ jobId: 'job-3' });

    const file = path.join(dir, 'compound.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    lines.splice(1, 1); // delete the middle record
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const result = auditLog.verifyStreamIntegrity('compound');
    expect(result.isValid).toBe(false);
    expect(['sequence-gap', 'chain-break']).toContain(result.reason);
  });

  test('exportStream returns only records within the given time range', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const first = appendSample();

      jest.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
      appendSample({ jobId: 'job-2' });

      const all = auditLog.exportStream('compound');
      expect(all).toHaveLength(2);

      const onlyFirst = auditLog.exportStream('compound', undefined, first.timestamp);
      expect(onlyFirst.map((r) => r.jobId)).toEqual(['job-1']);

      const onlySecond = auditLog.exportStream('compound', '2026-01-01T00:05:00.000Z');
      expect(onlySecond.map((r) => r.jobId)).toEqual(['job-2']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('redacts a Bearer token and a Stellar secret key before they are persisted', () => {
    appendSample({
      inputs: {
        note: 'Authorization: Bearer abc123.def456-ghi',
        secret: 'S' + 'A'.repeat(55),
      },
    });

    const file = path.join(dir, 'compound.jsonl');
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('abc123.def456-ghi');
    expect(raw).not.toContain('S' + 'A'.repeat(55));
    expect(raw).toContain('[REDACTED]');
  });

  test('appendDecision creates the stream directory on first write', () => {
    const freshDir = path.join(dir, 'nested', 'audit-dir');
    const scopedLog = createKeeperAuditLog(freshDir);
    scopedLog.appendDecision('liquidation', {
      workerName: 'LiquidationWorker',
      policyVersion: 'v1',
      contractId: 'CSTABLE',
      method: 'liquidate',
      decision: 'invoke liquidate on CSTABLE',
    });

    expect(fs.existsSync(path.join(freshDir, 'liquidation.jsonl'))).toBe(true);
  });
});
