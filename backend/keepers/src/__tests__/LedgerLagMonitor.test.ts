/**
 * Unit tests for LedgerLagMonitor — #1298 ledger lag health indicator.
 */
import { LedgerLagMonitor, DEFAULT_STALE_THRESHOLD_MS } from '../monitors/LedgerLagMonitor';

describe('LedgerLagMonitor', () => {
  let monitor: LedgerLagMonitor;

  beforeEach(() => {
    monitor = new LedgerLagMonitor(60_000); // 60 s stale threshold for tests
  });

  // ── getSnapshot() before any read ─────────────────────────────────────────

  test('lagStatus is "unknown" before any successful read is recorded', () => {
    const snap = monitor.getSnapshot();
    expect(snap.lagStatus).toBe('unknown');
    expect(snap.dataFreshnessMs).toBeNull();
    expect(snap.lastSuccessAt).toBeNull();
  });

  // ── recordSuccess() + getSnapshot() ───────────────────────────────────────

  test('lagStatus is "fresh" immediately after a successful read', () => {
    const now = Date.now();
    monitor.recordSuccess(now);
    const snap = monitor.getSnapshot(now);

    expect(snap.lagStatus).toBe('fresh');
    expect(snap.dataFreshnessMs).toBe(0);
    expect(snap.lastSuccessAt).toBe(new Date(now).toISOString());
  });

  test('dataFreshnessMs reflects time elapsed since last success', () => {
    const successAt = Date.now() - 30_000; // 30 s ago
    monitor.recordSuccess(successAt);
    const snap = monitor.getSnapshot(Date.now());

    expect(snap.dataFreshnessMs).toBeGreaterThanOrEqual(29_000);
    expect(snap.lagStatus).toBe('fresh'); // under 60 s threshold
  });

  test('lagStatus becomes "stale" once the threshold is exceeded', () => {
    const successAt = Date.now() - 120_000; // 120 s ago, threshold is 60 s
    monitor.recordSuccess(successAt);
    const snap = monitor.getSnapshot(Date.now());

    expect(snap.lagStatus).toBe('stale');
    expect(snap.dataFreshnessMs).toBeGreaterThanOrEqual(60_000);
  });

  test('lagStatus returns to "fresh" after a new success is recorded', () => {
    const oldSuccessAt = Date.now() - 120_000;
    monitor.recordSuccess(oldSuccessAt);
    expect(monitor.getSnapshot().lagStatus).toBe('stale');

    monitor.recordSuccess(Date.now());
    expect(monitor.getSnapshot().lagStatus).toBe('fresh');
  });

  // ── dataFreshnessMs clamp ─────────────────────────────────────────────────

  test('dataFreshnessMs is never negative (clock skew protection)', () => {
    const futureMs = Date.now() + 5_000;
    monitor.recordSuccess(futureMs);
    const snap = monitor.getSnapshot(Date.now()); // "now" is before the recorded time

    expect(snap.dataFreshnessMs).toBe(0);
  });

  // ── reset() ───────────────────────────────────────────────────────────────

  test('reset() returns the monitor to the never-read state', () => {
    monitor.recordSuccess();
    monitor.reset();
    const snap = monitor.getSnapshot();

    expect(snap.lagStatus).toBe('unknown');
    expect(snap.dataFreshnessMs).toBeNull();
  });

  // ── Custom stale threshold ─────────────────────────────────────────────────

  test('respects a custom stale threshold passed at construction', () => {
    const strict = new LedgerLagMonitor(10_000); // 10 s
    strict.recordSuccess(Date.now() - 15_000);   // 15 s ago
    expect(strict.getSnapshot().lagStatus).toBe('stale');

    const lenient = new LedgerLagMonitor(60_000);
    lenient.recordSuccess(Date.now() - 15_000);
    expect(lenient.getSnapshot().lagStatus).toBe('fresh');
  });

  // ── DEFAULT_STALE_THRESHOLD_MS constant ───────────────────────────────────

  test('DEFAULT_STALE_THRESHOLD_MS is a positive number', () => {
    expect(DEFAULT_STALE_THRESHOLD_MS).toBeGreaterThan(0);
  });
});
