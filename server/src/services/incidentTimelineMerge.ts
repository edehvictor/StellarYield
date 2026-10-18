import { AlertSeverity, normalizeSeverity } from "../utils/alertSeverity";

/**
 * Incident timeline merge logic (#1110).
 *
 * The same real-world incident can be reported to the timeline by more than
 * one source (e.g. an automated on-chain monitor AND a manual/ops report,
 * or two independent monitors that both observe the same protocol event).
 * Left unmerged, these show up as separate timeline entries with duplicate
 * (and sometimes conflicting) context, which is confusing for anyone
 * reading the timeline and can make claim/response behavior look
 * inconsistent.
 *
 * This module groups duplicate incident notifications and merges each group
 * into a single timeline item, deterministically, using the rules below.
 */

/** A single incident notification as reported by one source. */
export interface IncidentTimelineRecord {
  /** Notification id from the reporting source (not globally unique across sources). */
  id: string;
  /** Where this notification came from, e.g. "on-chain-monitor", "ops-manual", "partner-webhook". */
  source: string;
  protocol: string;
  type: string;
  /** Free-text severity label; normalized via {@link normalizeSeverity} during merge. */
  severity: string;
  title: string;
  description: string;
  affectedVaults: string[];
  startedAt: Date;
  resolved: boolean;
  resolvedAt?: Date | null;
  postmortemUrl?: string | null;
}

/** A merged timeline item, combining one or more duplicate source records. */
export interface MergedIncidentTimelineEntry {
  /** Deterministic group key (see {@link incidentDuplicateKey}); stable across merges of the same underlying incident. */
  mergeKey: string;
  protocol: string;
  type: string;
  /** Highest severity reported by any contributing source (see module docs for the tie-break rule). */
  severity: AlertSeverity;
  /** Richest (longest, most informative) title among contributing sources. */
  title: string;
  /** Richest (longest) description among contributing sources. */
  description: string;
  /** Union of affected vaults across all contributing sources. */
  affectedVaults: string[];
  /** Earliest reported start time across contributing sources. */
  startedAt: Date;
  /** Resolved if ANY contributing source reports it resolved. */
  resolved: boolean;
  /** Earliest resolvedAt among sources that reported resolution, if resolved. */
  resolvedAt: Date | null;
  /** First non-null postmortem URL found among contributing sources. */
  postmortemUrl: string | null;
  /** Every distinct source that reported this incident, sorted for determinism. */
  sources: string[];
  /** All raw records that were merged into this entry, newest-reported first. */
  mergedFrom: IncidentTimelineRecord[];
}

/**
 * Default window (ms) within which two records for the same protocol + type
 * are considered the same real-world incident. Different sources rarely
 * observe/report the exact same instant, so exact-timestamp equality is too
 * strict; this bucket makes "duplicate" detection robust to that skew while
 * staying deterministic and documented, same approach as
 * `transactionFingerprint.ts`'s timestamp bucketing.
 */
export const DEFAULT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Deterministic duplicate-group key for an incident record: protocol + type
 * + a bucketed start time. Two records with the same key are treated as the
 * same underlying incident and merged together.
 *
 * NOTE: bucketing is anchored to epoch time (not to either record's own
 * timestamp), so any two records whose `startedAt` values fall in the same
 * fixed-width window always produce the same key regardless of which one is
 * processed first (order-independent, unlike a "nearest neighbor" approach).
 */
export function incidentDuplicateKey(
  record: Pick<IncidentTimelineRecord, "protocol" | "type" | "startedAt">,
  windowMs: number = DEFAULT_DUPLICATE_WINDOW_MS,
): string {
  const bucket = Math.floor(record.startedAt.getTime() / windowMs);
  return [record.protocol.trim().toLowerCase(), record.type.trim().toLowerCase(), String(bucket)].join(
    "\u0000",
  );
}

/** Severity rank used to pick the "richest" (highest) severity across duplicates. Higher = more severe. */
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  [AlertSeverity.LOW]: 0,
  [AlertSeverity.MEDIUM]: 1,
  [AlertSeverity.HIGH]: 2,
  [AlertSeverity.CRITICAL]: 3,
};

/** Picks the longer of two strings (ties keep `a`), treating empty/undefined as least-rich. */
function richerText(a: string, b: string): string {
  return (b?.length ?? 0) > (a?.length ?? 0) ? b : a;
}

/**
 * Merges a group of duplicate incident records (same {@link incidentDuplicateKey})
 * into a single timeline entry.
 *
 * Conflicting-field tie-break rules (deterministic, documented):
 * - `severity`: highest-severity-wins (LOW < MEDIUM < HIGH < CRITICAL). An
 *   incident should never be under-reported in the merged view just because
 *   one source classified it more mildly than another.
 * - `title` / `description`: richest-field-wins, i.e. the longer non-empty
 *   string. A fuller manual report is preferred over a terse automated one.
 * - `affectedVaults`: union of all sources' vault lists (deduped), since
 *   under-reporting affected vaults would hide real impact.
 * - `startedAt`: earliest-wins, since the incident began when the first
 *   source observed it, not when the last one caught up.
 * - `resolved` / `resolvedAt`: resolved-wins — if ANY source reports the
 *   incident resolved, the merged entry is resolved, using the EARLIEST
 *   `resolvedAt` among those sources (most-recent-wins would understate how
 *   long the incident was actually active for responders reading the
 *   timeline after the fact).
 * - `postmortemUrl`: first non-null value found (stable by input order).
 *
 * The input array is never mutated. Throws if given an empty array or if
 * records disagree on protocol/type in a way inconsistent with a shared key
 * (defensive; callers should only pass one duplicate group at a time).
 */
export function mergeIncidentDuplicates(
  duplicates: IncidentTimelineRecord[],
  windowMs: number = DEFAULT_DUPLICATE_WINDOW_MS,
): MergedIncidentTimelineEntry {
  if (duplicates.length === 0) {
    throw new Error("mergeIncidentDuplicates requires at least one record");
  }

  const mergeKey = incidentDuplicateKey(duplicates[0], windowMs);
  for (const record of duplicates) {
    if (incidentDuplicateKey(record, windowMs) !== mergeKey) {
      throw new Error(
        `mergeIncidentDuplicates received records from different duplicate groups: ` +
          `expected key "${mergeKey}" but record ${record.id} (source: ${record.source}) has key ` +
          `"${incidentDuplicateKey(record, windowMs)}"`,
      );
    }
  }

  let severity: AlertSeverity = normalizeSeverity(duplicates[0].severity);
  let title = duplicates[0].title;
  let description = duplicates[0].description;
  const affectedVaultsSet = new Set<string>();
  let startedAt = duplicates[0].startedAt;
  let resolved = false;
  let resolvedAt: Date | null = null;
  let postmortemUrl: string | null = null;
  const sourcesSet = new Set<string>();

  for (const record of duplicates) {
    const recordSeverity = normalizeSeverity(record.severity);
    if (SEVERITY_RANK[recordSeverity] > SEVERITY_RANK[severity]) {
      severity = recordSeverity;
    }

    title = richerText(title, record.title);
    description = richerText(description, record.description);

    for (const vault of record.affectedVaults) {
      affectedVaultsSet.add(vault);
    }

    if (record.startedAt.getTime() < startedAt.getTime()) {
      startedAt = record.startedAt;
    }

    if (record.resolved) {
      resolved = true;
      const candidateResolvedAt = record.resolvedAt ?? record.startedAt;
      if (resolvedAt === null || candidateResolvedAt.getTime() < resolvedAt.getTime()) {
        resolvedAt = candidateResolvedAt;
      }
    }

    if (postmortemUrl === null && record.postmortemUrl) {
      postmortemUrl = record.postmortemUrl;
    }

    sourcesSet.add(record.source);
  }

  return {
    mergeKey,
    protocol: duplicates[0].protocol,
    type: duplicates[0].type,
    severity,
    title,
    description,
    affectedVaults: Array.from(affectedVaultsSet).sort(),
    startedAt,
    resolved,
    resolvedAt: resolved ? resolvedAt : null,
    postmortemUrl,
    sources: Array.from(sourcesSet).sort(),
    mergedFrom: [...duplicates],
  };
}

/**
 * Groups a batch of (possibly duplicate, possibly multi-source) incident
 * records by {@link incidentDuplicateKey} and merges each group via
 * {@link mergeIncidentDuplicates}, so the resulting timeline renders each
 * real-world incident exactly once regardless of how many sources reported
 * it.
 *
 * Output is sorted newest-first by merged `startedAt`, matching the sort
 * order `IncidentService.getIncidents` already uses.
 */
export function buildMergedIncidentTimeline(
  records: IncidentTimelineRecord[],
  windowMs: number = DEFAULT_DUPLICATE_WINDOW_MS,
): MergedIncidentTimelineEntry[] {
  const groups = new Map<string, IncidentTimelineRecord[]>();

  for (const record of records) {
    const key = incidentDuplicateKey(record, windowMs);
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  const merged = Array.from(groups.values()).map((group) => mergeIncidentDuplicates(group, windowMs));

  return merged.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}
