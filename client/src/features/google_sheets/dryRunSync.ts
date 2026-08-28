/**
 * Google Sheets dry-run sync planning (#962).
 *
 * Given the metrics we want to write and a snapshot of what is currently in
 * the linked spreadsheet, compute what a real sync *would* do — without
 * writing anything — so the panel can show the user a preview and let them
 * confirm before committing.
 */

import type { DailyYieldMetric } from "./types";

export type SheetRowAction = "added" | "updated" | "skipped" | "conflicted";

/** The identity of a spreadsheet row: one row per wallet/vault/asset/day. */
export interface SheetRowKey {
  walletAddress: string;
  vaultName: string;
  asset: string;
  timestamp: string;
}

/** A row already present in the linked spreadsheet, as read back for comparison. */
export interface ExistingSheetRow {
  walletAddress: string;
  vaultName: string;
  asset: string;
  timestamp: string;
  depositAmount: string;
  currentValue: string;
  dailyYield: string;
  apy: string;
  /**
   * True when the existing row is a known incomplete placeholder (e.g. a
   * prior partial sync). Placeholders are safe to overwrite as an 'updated'
   * row rather than being flagged as a conflict.
   */
  isPlaceholder?: boolean;
}

export interface SyncRowPlan {
  key: SheetRowKey;
  action: SheetRowAction;
  metric: DailyYieldMetric;
  existingRow?: ExistingSheetRow;
  reason: string;
}

export interface DryRunSyncSummary {
  added: SyncRowPlan[];
  updated: SyncRowPlan[];
  skipped: SyncRowPlan[];
  conflicted: SyncRowPlan[];
  totalRows: number;
}

const DEFAULT_WALLET = "unknown-wallet";
const DEFAULT_ASSET = "unknown-asset";
const APY_TOLERANCE = 0.005;

export function buildRowKey(metric: DailyYieldMetric): SheetRowKey {
  return {
    walletAddress: metric.walletAddress ?? DEFAULT_WALLET,
    vaultName: metric.vaultName,
    asset: metric.asset ?? DEFAULT_ASSET,
    timestamp: metric.date,
  };
}

export function rowKeyToString(key: SheetRowKey): string {
  return [key.walletAddress, key.vaultName, key.asset, key.timestamp].join("::");
}

/** Whether a metric's values exactly match what's already recorded for its key. */
function valuesMatch(metric: DailyYieldMetric, existing: ExistingSheetRow): boolean {
  return (
    metric.depositAmount.toString() === existing.depositAmount &&
    metric.currentValue.toString() === existing.currentValue &&
    metric.dailyYield.toString() === existing.dailyYield &&
    Math.abs(metric.apy - Number.parseFloat(existing.apy)) < APY_TOLERANCE
  );
}

/**
 * Compute a dry-run sync plan: for each incoming metric, decide whether it
 * would be added, update an existing row, be skipped as a no-op, or
 * conflict with an existing row that holds different, non-placeholder data.
 *
 * A within-batch duplicate (two incoming metrics resolving to the same row
 * key) is also surfaced as a conflict on the later entry — ambiguous source
 * data should never be silently resolved by "last write wins".
 */
export function computeDryRunSyncPlan(
  metrics: DailyYieldMetric[],
  existingRows: ExistingSheetRow[],
): DryRunSyncSummary {
  const existingByKey = new Map<string, ExistingSheetRow>();
  for (const row of existingRows) {
    existingByKey.set(
      rowKeyToString({
        walletAddress: row.walletAddress,
        vaultName: row.vaultName,
        asset: row.asset,
        timestamp: row.timestamp,
      }),
      row,
    );
  }

  const summary: DryRunSyncSummary = { added: [], updated: [], skipped: [], conflicted: [], totalRows: 0 };
  const seenInBatch = new Set<string>();

  for (const metric of metrics) {
    const key = buildRowKey(metric);
    const keyStr = rowKeyToString(key);
    summary.totalRows += 1;

    if (seenInBatch.has(keyStr)) {
      summary.conflicted.push({
        key,
        action: "conflicted",
        metric,
        reason: `Duplicate entry for ${key.walletAddress}/${key.vaultName}/${key.asset} on ${key.timestamp} within the same sync batch.`,
      });
      continue;
    }
    seenInBatch.add(keyStr);

    const existing = existingByKey.get(keyStr);

    if (!existing) {
      summary.added.push({
        key,
        action: "added",
        metric,
        reason: "No existing row for this wallet/vault/asset/day.",
      });
      continue;
    }

    if (valuesMatch(metric, existing)) {
      summary.skipped.push({
        key,
        action: "skipped",
        metric,
        existingRow: existing,
        reason: "Existing row already matches — nothing to write.",
      });
      continue;
    }

    if (existing.isPlaceholder) {
      summary.updated.push({
        key,
        action: "updated",
        metric,
        existingRow: existing,
        reason: "Existing row was an incomplete placeholder — safe to overwrite.",
      });
      continue;
    }

    summary.conflicted.push({
      key,
      action: "conflicted",
      metric,
      existingRow: existing,
      reason: `Existing row for this wallet/vault/asset/day holds different values than the new sync data. Refusing to overwrite automatically — review and resolve manually.`,
    });
  }

  return summary;
}
