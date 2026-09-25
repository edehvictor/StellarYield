export type ProviderUptimeStatus = "high" | "medium" | "low" | "unreliable" | "unknown";

export interface ProviderUptimeSample {
  providerId: string;
  providerName: string;
  sourceGroup?: string;
  dataSource?: string;
  status: ProviderUptimeStatus;
  lastUpdated: string | Date;
}

export interface ProviderUptimeReportFilters {
  providerId?: string | string[];
  sourceGroup?: string | string[];
  startDate?: string | Date;
  endDate?: string | Date;
}

export interface ProviderUptimeAlertWindow {
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number;
  status: "low" | "unreliable";
  alertLevel: "low" | "unreliable";
}

export interface ProviderUptimeRecoveryInterval {
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number;
  alertStartedAt: string;
  alertEndedAt: string | null;
}

export interface ProviderUptimeReportRow {
  providerId: string;
  providerName: string;
  sourceGroup: string;
  periodStart: string;
  periodEnd: string;
  sampleCount: number;
  uptimeMinutes: number;
  downtimeMinutes: number;
  unknownMinutes: number;
  uptimePct: number;
  downtimePct: number;
  unknownPct: number;
  alertWindowCount: number;
  alertWindows: ProviderUptimeAlertWindow[];
  recoveryIntervalCount: number;
  recoveryIntervals: ProviderUptimeRecoveryInterval[];
  generatedAt: string;
}

export interface ProviderUptimeReportExport {
  generatedAt: string;
  rows: ProviderUptimeReportRow[];
}

function toIso(value: string | Date | number): string {
  return new Date(value).toISOString();
}

function toTime(value: string | Date | number): number {
  return new Date(value).getTime();
}

function isHealthy(status: ProviderUptimeStatus): boolean {
  return status === "high" || status === "medium";
}

function isDown(status: ProviderUptimeStatus): boolean {
  return status === "low" || status === "unreliable";
}

function normalizeSourceGroup(record: Pick<ProviderUptimeSample, "sourceGroup" | "dataSource">): string {
  return record.sourceGroup ?? record.dataSource ?? "unknown";
}

function parseFilterValues(values?: string | string[]): string[] {
  if (!values) return [];
  if (Array.isArray(values)) {
    return values.map((value) => String(value).trim()).filter(Boolean);
  }
  return [String(values).trim()].filter(Boolean);
}

function clampInterval(start: number, end: number, rangeStart: number, rangeEnd: number): [number, number] {
  const clippedStart = Math.max(start, rangeStart);
  const clippedEnd = Math.min(end, rangeEnd);
  return [clippedStart, clippedEnd];
}

function mergeOverlappingRanges(
  ranges: Array<{ start: number; end: number; statuses?: ProviderUptimeStatus[] }>,
): Array<{ start: number; end: number; statuses: ProviderUptimeStatus[] }> {
  if (!ranges.length) return [];

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number; statuses: ProviderUptimeStatus[] }> = [{
    start: sorted[0].start,
    end: sorted[0].end,
    statuses: sorted[0].statuses ?? [],
  }];

  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
      if (current.statuses?.length) {
        last.statuses.push(...current.statuses);
      }
    } else {
      merged.push({
        start: current.start,
        end: current.end,
        statuses: current.statuses ?? [],
      });
    }
  }

  return merged;
}

function chooseAlertStatus(statuses: ProviderUptimeStatus[]): ProviderUptimeAlertWindow["status"] {
  return statuses.includes("unreliable") ? "unreliable" : "low";
}

function matchesFilters(record: ProviderUptimeSample, filters: ProviderUptimeReportFilters): boolean {
  const providerValues = parseFilterValues(filters.providerId);
  const sourceValues = parseFilterValues(filters.sourceGroup);

  if (providerValues.length > 0 && !providerValues.includes(record.providerId)) {
    return false;
  }

  const sourceGroup = normalizeSourceGroup(record);
  if (sourceValues.length > 0 && !sourceValues.includes(sourceGroup)) {
    return false;
  }

  const lastUpdated = toTime(record.lastUpdated);
  if (filters.startDate && lastUpdated < toTime(filters.startDate)) {
    return false;
  }
  if (filters.endDate && lastUpdated > toTime(filters.endDate)) {
    return false;
  }

  return true;
}

function buildAlertWindows(
  alertRanges: Array<{ start: number; end: number; statuses?: ProviderUptimeStatus[] }>,
  periodStart: number,
  periodEnd: number,
): ProviderUptimeAlertWindow[] {
  return mergeOverlappingRanges(alertRanges)
    .map((segment) => {
      const [clippedStart, clippedEnd] = clampInterval(segment.start, segment.end, periodStart, periodEnd);
      if (clippedEnd <= clippedStart) {
        return null;
      }

      const status = chooseAlertStatus(segment.statuses);
      return {
        startedAt: toIso(clippedStart),
        endedAt: clippedEnd >= periodEnd ? null : toIso(clippedEnd),
        durationMinutes: (clippedEnd - clippedStart) / 60_000,
        status,
        alertLevel: status,
      };
    })
    .filter((window): window is ProviderUptimeAlertWindow => Boolean(window));
}

function buildRecoveryIntervals(
  alertWindows: ProviderUptimeAlertWindow[],
  periodStart: number,
  periodEnd: number,
  healthyRanges: Array<{ start: number; end: number }>,
): ProviderUptimeRecoveryInterval[] {
  const healthyStarts = healthyRanges
    .map((segment) => segment.start)
    .filter((time) => time >= periodStart && time <= periodEnd)
    .sort((a, b) => a - b);

  return alertWindows.flatMap((alert) => {
    const alertEndedMs = alert.endedAt ? toTime(alert.endedAt) : periodEnd;
    const nextHealthyStart = healthyStarts.find((candidate) => candidate > alertEndedMs);

    if (nextHealthyStart === undefined) {
      return [];
    }

    const recoveryStart = alertEndedMs;
    const recoveryEnd = Math.min(nextHealthyStart, periodEnd);
    if (recoveryEnd <= recoveryStart) {
      return [];
    }

    return [{
      startedAt: toIso(recoveryStart),
      endedAt: recoveryEnd >= periodEnd ? null : toIso(recoveryEnd),
      durationMinutes: (recoveryEnd - recoveryStart) / 60_000,
      alertStartedAt: alert.startedAt,
      alertEndedAt: alert.endedAt,
    }];
  });
}

function calculatePercent(totalMinutes: number, valueMinutes: number): number {
  if (totalMinutes <= 0) return 0;
  return Math.round((valueMinutes / totalMinutes) * 1000) / 10;
}

export function buildProviderUptimeReportExport(
  records: ProviderUptimeSample[],
  filters: ProviderUptimeReportFilters = {},
): ProviderUptimeReportExport {
  const normalizedRecords = records
    .map((record) => ({
      ...record,
      status: record.status ?? "unknown",
      sourceGroup: normalizeSourceGroup(record),
    }))
    .filter((record) => matchesFilters(record, filters));

  const groups = new Map<string, ProviderUptimeSample[]>();
  for (const record of normalizedRecords) {
    const key = `${record.providerId}::${normalizeSourceGroup(record)}`;
    const current = groups.get(key) ?? [];
    current.push(record);
    groups.set(key, current.sort((a, b) => toTime(a.lastUpdated) - toTime(b.lastUpdated)));
  }

  const rows: ProviderUptimeReportRow[] = [];

  for (const group of groups.values()) {
    if (!group.length) continue;

    const ordered = [...group].sort((a, b) => toTime(a.lastUpdated) - toTime(b.lastUpdated));
    const provider = ordered[0];
    const sourceGroup = normalizeSourceGroup(provider);

    const periodStart = filters.startDate ? toTime(filters.startDate) : toTime(ordered[0].lastUpdated);
    const periodEnd = filters.endDate ? toTime(filters.endDate) : toTime(ordered[ordered.length - 1].lastUpdated);
    if (periodEnd <= periodStart) continue;

    const segments: Array<{ start: number; end: number; status: ProviderUptimeStatus }> = [];

    if (ordered[0] && toTime(ordered[0].lastUpdated) > periodStart) {
      segments.push({
        start: periodStart,
        end: toTime(ordered[0].lastUpdated),
        status: "unknown",
      });
    }

    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      const currentTime = toTime(current.lastUpdated);
      const nextTime = index + 1 < ordered.length ? toTime(ordered[index + 1].lastUpdated) : periodEnd;
      const start = Math.max(currentTime, periodStart);
      const end = Math.min(nextTime, periodEnd);
      if (end > start) {
        segments.push({ start, end, status: current.status });
      }
    }

    let uptimeMinutes = 0;
    let downtimeMinutes = 0;
    let unknownMinutes = 0;
    const downSegments: Array<{ start: number; end: number; statuses: ProviderUptimeStatus[] }> = [];
    const healthySegments: Array<{ start: number; end: number }> = [];

    for (const segment of segments) {
      const durationMinutes = (segment.end - segment.start) / 60_000;
      if (isHealthy(segment.status)) {
        uptimeMinutes += durationMinutes;
        healthySegments.push({ start: segment.start, end: segment.end });
      } else if (isDown(segment.status)) {
        downtimeMinutes += durationMinutes;
        downSegments.push({ start: segment.start, end: segment.end, statuses: [segment.status] });
      } else {
        unknownMinutes += durationMinutes;
      }
    }

    const totalMinutes = (periodEnd - periodStart) / 60_000;
    const mergedDownRanges = mergeOverlappingRanges(downSegments);
    const alertWindows = buildAlertWindows(
      mergedDownRanges.map((segment) => ({
        start: segment.start,
        end: segment.end,
        statuses: segment.statuses,
      })),
      periodStart,
      periodEnd,
    );
    const recoveryIntervals = buildRecoveryIntervals(alertWindows, periodStart, periodEnd, healthySegments);

    rows.push({
      providerId: provider.providerId,
      providerName: provider.providerName,
      sourceGroup,
      periodStart: toIso(periodStart),
      periodEnd: toIso(periodEnd),
      sampleCount: ordered.length,
      uptimeMinutes,
      downtimeMinutes,
      unknownMinutes,
      uptimePct: calculatePercent(totalMinutes, uptimeMinutes),
      downtimePct: calculatePercent(totalMinutes, downtimeMinutes),
      unknownPct: calculatePercent(totalMinutes, unknownMinutes),
      alertWindowCount: alertWindows.length,
      alertWindows,
      recoveryIntervalCount: recoveryIntervals.length,
      recoveryIntervals,
      generatedAt: new Date().toISOString(),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    rows,
  };
}

export function generateProviderUptimeReportExport(
  records: ProviderUptimeSample[],
  filters: ProviderUptimeReportFilters = {},
): ProviderUptimeReportExport {
  return buildProviderUptimeReportExport(records, filters);
}

export function exportProviderUptimeReportCsv(exportData: ProviderUptimeReportExport): string {
  const headers = [
    "providerId",
    "providerName",
    "sourceGroup",
    "periodStart",
    "periodEnd",
    "sampleCount",
    "uptimeMinutes",
    "downtimeMinutes",
    "unknownMinutes",
    "uptimePct",
    "downtimePct",
    "unknownPct",
    "alertWindowCount",
    "recoveryIntervalCount",
  ];

  const escapeCsv = (value: unknown): string => {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const rows = exportData.rows.map((row) => [
    row.providerId,
    row.providerName,
    row.sourceGroup,
    row.periodStart,
    row.periodEnd,
    row.sampleCount,
    row.uptimeMinutes,
    row.downtimeMinutes,
    row.unknownMinutes,
    row.uptimePct,
    row.downtimePct,
    row.unknownPct,
    row.alertWindowCount,
    row.recoveryIntervalCount,
  ].map(escapeCsv).join(","));

  return [headers.join(","), ...rows].join("\n");
}

export const providerUptimeReportService = {
  buildProviderUptimeReportExport,
  generateProviderUptimeReportExport,
  exportProviderUptimeReportCsv,
};

export default providerUptimeReportService;
