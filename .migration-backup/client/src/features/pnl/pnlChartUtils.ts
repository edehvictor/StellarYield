export interface DailyPnLSnapshot {
  date: string;
  cumulativePnL: number;
  portfolioValue: number;
  sharePrice: number;
}

export interface PnLData {
  totalDeposited: number;
  totalWithdrawn: number;
  currentValue: number;
  costBasis: number;
  absolutePnL: number;
  twrPercent: number;
  dailySnapshots: DailyPnLSnapshot[];
}

type RawSnapshot = {
  date?: unknown;
  cumulativePnL?: unknown;
  portfolioValue?: unknown;
  sharePrice?: unknown;
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalize a single daily snapshot, dropping invalid rows.
 */
export function normalizeSnapshotPoint(raw: RawSnapshot): DailyPnLSnapshot | null {
  if (typeof raw.date !== "string") return null;
  const parsed = new Date(raw.date);
  if (Number.isNaN(parsed.getTime())) return null;

  const cumulativePnL = toFiniteNumber(raw.cumulativePnL);
  const portfolioValue = toFiniteNumber(raw.portfolioValue);
  const sharePrice = toFiniteNumber(raw.sharePrice, 1);

  return {
    date: raw.date,
    cumulativePnL,
    portfolioValue,
    sharePrice: sharePrice > 0 ? sharePrice : 1,
  };
}

/**
 * Sort by date ascending and deduplicate by date (last wins).
 */
export function normalizeDailySnapshots(
  snapshots: RawSnapshot[] | undefined | null,
): DailyPnLSnapshot[] {
  if (!Array.isArray(snapshots)) return [];

  const byDate = new Map<string, DailyPnLSnapshot>();
  for (const raw of snapshots) {
    const point = normalizeSnapshotPoint(raw);
    if (point) {
      byDate.set(point.date, point);
    }
  }

  return [...byDate.values()].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
}

/**
 * Normalize API PnL payload for safe chart rendering.
 */
export function normalizePnLData(raw: Partial<PnLData> | null | undefined): PnLData {
  return {
    totalDeposited: toFiniteNumber(raw?.totalDeposited),
    totalWithdrawn: toFiniteNumber(raw?.totalWithdrawn),
    currentValue: toFiniteNumber(raw?.currentValue),
    costBasis: toFiniteNumber(raw?.costBasis),
    absolutePnL: toFiniteNumber(raw?.absolutePnL),
    twrPercent: toFiniteNumber(raw?.twrPercent),
    dailySnapshots: normalizeDailySnapshots(raw?.dailySnapshots),
  };
}

export function hasNoData(data: PnLData | null): boolean {
  if (!data) return true;
  return data.totalDeposited === 0 && data.dailySnapshots.length === 0;
}

export function hasPartialData(data: PnLData | null): boolean {
  if (!data) return false;
  return data.totalDeposited > 0 && data.dailySnapshots.length === 0;
}

export function isSparseChartData(snapshots: DailyPnLSnapshot[]): boolean {
  return snapshots.length > 0 && snapshots.length < 3;
}
