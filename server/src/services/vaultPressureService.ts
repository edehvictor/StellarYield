/**
 * Vault Inflow and Outflow Pressure Analyzer (#276)
 *
 * Tracks deposit and withdrawal velocity per vault using a sliding time window.
 * Exposes aggregate pressure metrics without revealing individual user activity.
 *
 * Pressure Levels:
 *   - NORMAL  : within configured baseline band
 *   - ELEVATED: 1×–2× baseline velocity
 *   - HIGH    : 2×–4× baseline velocity
 *   - CRITICAL: > 4× baseline velocity
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type PressureLevel = "NORMAL" | "ELEVATED" | "HIGH" | "CRITICAL";
export type FlowDirection = "inflow" | "outflow";

export interface FlowEvent {
  vaultId: string;
  direction: FlowDirection;
  /** Amount in USDC-equivalent stroop units (i128). */
  amount: bigint;
  timestamp: number; // Unix ms
}

export interface VaultPressureMetrics {
  vaultId: string;
  windowMs: number;
  inflowVelocity: number; // USDC per second (aggregate, no per-user data)
  outflowVelocity: number;
  netVelocity: number; // positive = net inflow
  inflowPressure: PressureLevel;
  outflowPressure: PressureLevel;
  totalInflowInWindow: bigint;
  totalOutflowInWindow: bigint;
  eventCount: number;
  computedAt: number;
}

export interface PressureThresholds {
  /** Baseline velocity in USDC/s above which ELEVATED is triggered. */
  elevatedBps: number; // velocity relative to baseline × 100
  highBps: number;
  criticalBps: number;
  /** Expected baseline inflow velocity in USDC/s for this vault. */
  baselineVelocity: number;
}

export const DEFAULT_THRESHOLDS: PressureThresholds = {
  baselineVelocity: 100, // USDC/s
  elevatedBps: 100, // 1× baseline
  highBps: 200, // 2× baseline
  criticalBps: 400, // 4× baseline
};

export const DEFAULT_WINDOW_MS = 5 * 60 * 1_000; // 5-minute sliding window

// ── In-memory event ring buffer ───────────────────────────────────────────────

const MAX_EVENTS_PER_VAULT = 10_000;

const _events: Map<string, FlowEvent[]> = new Map();
const _thresholds: Map<string, PressureThresholds> = new Map();

/** Record a flow event for a vault. */
export function recordFlowEvent(event: FlowEvent): void {
  const list = _events.get(event.vaultId) ?? [];
  list.push(event);
  // Evict oldest entries when buffer is full
  if (list.length > MAX_EVENTS_PER_VAULT) {
    list.splice(0, list.length - MAX_EVENTS_PER_VAULT);
  }
  _events.set(event.vaultId, list);
}

/** Set custom thresholds for a vault. */
export function setVaultThresholds(
  vaultId: string,
  thresholds: Partial<PressureThresholds>,
): void {
  const current = _thresholds.get(vaultId) ?? { ...DEFAULT_THRESHOLDS };
  _thresholds.set(vaultId, { ...current, ...thresholds });
}

/** Compute pressure metrics for a vault over the given window. */
export function computePressureMetrics(
  vaultId: string,
  windowMs: number = DEFAULT_WINDOW_MS,
  now: number = Date.now(),
): VaultPressureMetrics {
  const cutoff = now - windowMs;
  const all = _events.get(vaultId) ?? [];
  const inWindow = all.filter((e) => e.timestamp >= cutoff);

  let totalInflow = BigInt(0);
  let totalOutflow = BigInt(0);

  for (const e of inWindow) {
    if (e.direction === "inflow") totalInflow += e.amount;
    else totalOutflow += e.amount;
  }

  const windowSec = windowMs / 1_000;
  const inflowVelocity = windowSec > 0 ? Number(totalInflow) / windowSec : 0;
  const outflowVelocity = windowSec > 0 ? Number(totalOutflow) / windowSec : 0;

  const thresholds = _thresholds.get(vaultId) ?? DEFAULT_THRESHOLDS;

  return {
    vaultId,
    windowMs,
    inflowVelocity,
    outflowVelocity,
    netVelocity: inflowVelocity - outflowVelocity,
    inflowPressure: classifyPressure(inflowVelocity, thresholds),
    outflowPressure: classifyPressure(outflowVelocity, thresholds),
    totalInflowInWindow: totalInflow,
    totalOutflowInWindow: totalOutflow,
    eventCount: inWindow.length,
    computedAt: now,
  };
}

function classifyPressure(
  velocity: number,
  t: PressureThresholds,
): PressureLevel {
  const ratio = t.baselineVelocity > 0 ? (velocity / t.baselineVelocity) * 100 : 0;
  if (ratio >= t.criticalBps) return "CRITICAL";
  if (ratio >= t.highBps) return "HIGH";
  if (ratio >= t.elevatedBps) return "ELEVATED";
  return "NORMAL";
}

/** Return pressure metrics for all tracked vaults. */
export function getAllVaultPressure(
  windowMs?: number,
): VaultPressureMetrics[] {
  return Array.from(_events.keys()).map((id) =>
    computePressureMetrics(id, windowMs),
  );
}

/** Clear all events for a vault (for testing or reset). */
export function clearVaultEvents(vaultId: string): void {
  _events.delete(vaultId);
}
