/**
 * Portfolio snapshot comparison.
 *
 * Diffs two arbitrary `DailyPortfolioSnapshot` records (by date or id) rather
 * than only "today vs. yesterday" — see `calculateDailyMovement` in
 * `dailyMovement.ts` for the consecutive-day case this generalizes. Every
 * asset that appears in either snapshot is reported, tagged with whether it
 * was added, removed, or simply changed value, so a caller does not have to
 * infer "removed" from a value that happens to be zero.
 */

export type AssetComparisonStatus = "added" | "removed" | "changed" | "unchanged";

export interface AssetComparisonEntry {
  asset: string;
  status: AssetComparisonStatus;
  fromValueUsd: number;
  toValueUsd: number;
  fromQuantity: number;
  toQuantity: number;
  absoluteChange: number;
  /** Percentage change; null when the asset didn't exist in the "from" snapshot (undefined base). */
  percentChange: number | null;
}

export interface SnapshotComparisonInput {
  walletAddress: string;
  snapshotDate: string; // ISO date
  totalValueUsd: number;
  assetBreakdown: Record<string, { valueUsd: number; quantity: number }>;
}

export interface SnapshotComparisonResult {
  walletAddress: string;
  fromSnapshotDate: string;
  toSnapshotDate: string;
  fromTotalValueUsd: number;
  toTotalValueUsd: number;
  totalAbsoluteChange: number;
  /** Percentage change in total value; null when the "from" total is 0 and "to" is also 0. */
  totalPercentChange: number | null;
  assets: AssetComparisonEntry[];
  addedAssets: string[];
  removedAssets: string[];
}

/** Amounts closer than this are treated as unchanged (float rounding noise). */
const VALUE_EPSILON = 1e-8;

/**
 * Compares two portfolio snapshots for the same wallet and returns a
 * structured, per-asset diff plus the total value delta.
 *
 * `from` and `to` may be any two snapshots (not necessarily consecutive
 * days) — the caller decides which two to load and in which order.
 */
export function compareSnapshots(
  from: SnapshotComparisonInput,
  to: SnapshotComparisonInput,
): SnapshotComparisonResult {
  const allAssets = new Set([
    ...Object.keys(from.assetBreakdown ?? {}),
    ...Object.keys(to.assetBreakdown ?? {}),
  ]);

  const assets: AssetComparisonEntry[] = [];
  const addedAssets: string[] = [];
  const removedAssets: string[] = [];

  for (const asset of allAssets) {
    const fromData = from.assetBreakdown?.[asset];
    const toData = to.assetBreakdown?.[asset];

    const fromValueUsd = fromData?.valueUsd ?? 0;
    const toValueUsd = toData?.valueUsd ?? 0;
    const fromQuantity = fromData?.quantity ?? 0;
    const toQuantity = toData?.quantity ?? 0;

    const absoluteChange = toValueUsd - fromValueUsd;

    let status: AssetComparisonStatus;
    if (!fromData && toData) {
      status = "added";
      addedAssets.push(asset);
    } else if (fromData && !toData) {
      status = "removed";
      removedAssets.push(asset);
    } else if (Math.abs(absoluteChange) <= VALUE_EPSILON) {
      status = "unchanged";
    } else {
      status = "changed";
    }

    const percentChange =
      fromValueUsd !== 0 ? (absoluteChange / Math.abs(fromValueUsd)) * 100 : null;

    assets.push({
      asset,
      status,
      fromValueUsd,
      toValueUsd,
      fromQuantity,
      toQuantity,
      absoluteChange,
      percentChange,
    });
  }

  // Largest movers first, added/removed assets still show up wherever their
  // magnitude puts them.
  assets.sort((a, b) => Math.abs(b.absoluteChange) - Math.abs(a.absoluteChange));

  const totalAbsoluteChange = to.totalValueUsd - from.totalValueUsd;
  const totalPercentChange =
    from.totalValueUsd !== 0
      ? (totalAbsoluteChange / Math.abs(from.totalValueUsd)) * 100
      : null;

  return {
    walletAddress: to.walletAddress,
    fromSnapshotDate: from.snapshotDate,
    toSnapshotDate: to.snapshotDate,
    fromTotalValueUsd: from.totalValueUsd,
    toTotalValueUsd: to.totalValueUsd,
    totalAbsoluteChange,
    totalPercentChange,
    assets,
    addedAssets,
    removedAssets,
  };
}
