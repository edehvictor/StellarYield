import { formatDigest } from "./DigestFormatter";
import type {
  DigestPayload,
  ScheduleMode,
  WatchlistDigestPreference,
  WatchlistDigestTrigger,
  WatchlistEvent,
} from "./types";

export interface VaultWatchSnapshot {
  vaultId: string;
  apyPct: number;
  riskScore: number;
  freshnessHours: number;
  alertTriggered: boolean;
}

const watchlistPreferenceStore = new Map<string, WatchlistDigestPreference>();
const digestOperationStore = new Map<
  string,
  { fingerprint: string; result: WatchlistDigestPreference; createdAt: number }
>();

export const DIGEST_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;

export function clearWatchlistDigestOperationStore(): void {
  digestOperationStore.clear();
}

export function getWatchlistDigestPreference(
  walletAddress: string,
): WatchlistDigestPreference {
  return (
    watchlistPreferenceStore.get(walletAddress) ?? {
      enabled: false,
      scheduleMode: "weekly",
      eventThreshold: 2,
      watchedVaultIds: [],
      minApyDeltaPct: 0.5,
      minRiskDelta: 5,
      maxFreshnessHours: 12,
    }
  );
}

export function saveWatchlistDigestPreference(
  walletAddress: string,
  preference: WatchlistDigestPreference,
  operationIdentity?: string,
): WatchlistDigestPreference & { __replayed?: boolean } {
  const normalized: WatchlistDigestPreference = {
    enabled: preference.enabled,
    scheduleMode: preference.scheduleMode,
    eventThreshold: Math.max(1, Math.min(20, preference.eventThreshold)),
    watchedVaultIds: [...new Set(preference.watchedVaultIds)].filter(Boolean).sort(),
    minApyDeltaPct: Math.max(0, preference.minApyDeltaPct),
    minRiskDelta: Math.max(0, preference.minRiskDelta),
    maxFreshnessHours: Math.max(1, preference.maxFreshnessHours),
  };

  const currentFingerprint = JSON.stringify({
    walletAddress: walletAddress.toLowerCase(),
    enabled: normalized.enabled,
    scheduleMode: normalized.scheduleMode,
    eventThreshold: normalized.eventThreshold,
    watchedVaultIds: normalized.watchedVaultIds,
    minApyDeltaPct: normalized.minApyDeltaPct,
    minRiskDelta: normalized.minRiskDelta,
    maxFreshnessHours: normalized.maxFreshnessHours,
  });

  if (operationIdentity) {
    const existing = digestOperationStore.get(operationIdentity);
    if (existing) {
      if (Date.now() - existing.createdAt > DIGEST_OPERATION_TTL_MS) {
        digestOperationStore.delete(operationIdentity);
      } else if (existing.fingerprint === currentFingerprint) {
        return { ...existing.result, __replayed: true };
      } else {
        const error = new Error(
          "Operation identity has already been used with different parameters.",
        );
        (error as any).code = "OPERATION_IDENTITY_CONFLICT";
        throw error;
      }
    }
  }

  watchlistPreferenceStore.set(walletAddress, normalized);

  if (operationIdentity) {
    digestOperationStore.set(operationIdentity, {
      fingerprint: currentFingerprint,
      result: normalized,
      createdAt: Date.now(),
    });
  }

  return normalized;
}

function makeWatchlistEvent(
  walletAddress: string,
  vaultId: string,
  trigger: WatchlistDigestTrigger,
  severity: "info" | "warning" | "critical",
  conditionDescription: string,
  previousValue: number | null,
  currentValue: number | null,
): WatchlistEvent {
  const timestamp = new Date().toISOString();
  return {
    eventId: `watch-${vaultId}-${trigger}-${Date.now()}`,
    eventType: "watchlist",
    walletAddress,
    vaultId,
    trigger,
    severity,
    conditionDescription,
    previousValue,
    currentValue,
    triggeredAt: timestamp,
    recordedAt: timestamp,
  };
}

export function buildWatchlistDigestEvents(
  walletAddress: string,
  preference: WatchlistDigestPreference,
  previousSnapshots: VaultWatchSnapshot[],
  currentSnapshots: VaultWatchSnapshot[],
): WatchlistEvent[] {
  if (!preference.enabled || preference.watchedVaultIds.length === 0) {
    return [];
  }

  const previousByVault = new Map(
    previousSnapshots.map((snapshot) => [snapshot.vaultId, snapshot]),
  );

  const events: WatchlistEvent[] = [];
  for (const snapshot of currentSnapshots) {
    if (!preference.watchedVaultIds.includes(snapshot.vaultId)) {
      continue;
    }

    const previous = previousByVault.get(snapshot.vaultId);
    if (!previous) {
      continue;
    }

    const apyDelta = snapshot.apyPct - previous.apyPct;
    if (Math.abs(apyDelta) >= preference.minApyDeltaPct) {
      events.push(
        makeWatchlistEvent(
          walletAddress,
          snapshot.vaultId,
          "apy_change",
          Math.abs(apyDelta) >= preference.minApyDeltaPct * 2 ? "warning" : "info",
          `APY moved by ${apyDelta.toFixed(2)} percentage points`,
          previous.apyPct,
          snapshot.apyPct,
        ),
      );
    }

    const riskDelta = snapshot.riskScore - previous.riskScore;
    if (Math.abs(riskDelta) >= preference.minRiskDelta) {
      events.push(
        makeWatchlistEvent(
          walletAddress,
          snapshot.vaultId,
          "risk_change",
          riskDelta > 0 ? "critical" : "warning",
          `Risk score shifted by ${riskDelta.toFixed(1)} points`,
          previous.riskScore,
          snapshot.riskScore,
        ),
      );
    }

    if (
      snapshot.freshnessHours >= preference.maxFreshnessHours &&
      previous.freshnessHours < preference.maxFreshnessHours
    ) {
      events.push(
        makeWatchlistEvent(
          walletAddress,
          snapshot.vaultId,
          "freshness_change",
          "warning",
          `Freshness lag reached ${snapshot.freshnessHours.toFixed(1)} hours`,
          previous.freshnessHours,
          snapshot.freshnessHours,
        ),
      );
    }

    if (snapshot.alertTriggered && !previous.alertTriggered) {
      events.push(
        makeWatchlistEvent(
          walletAddress,
          snapshot.vaultId,
          "alert_triggered",
          "critical",
          "A linked alert fired for this watchlisted vault",
          0,
          1,
        ),
      );
    }
  }

  return events;
}

export function buildWatchlistDigestPreview(
  walletAddress: string,
  scheduleMode: ScheduleMode,
  events: WatchlistEvent[],
): DigestPayload {
  const clusters = events.map((event) => ({
    eventType: event.eventType,
    clusterKey: `${event.vaultId}:${event.trigger}`,
    vaultId: event.vaultId,
    events: [event],
    topImportanceScore:
      event.severity === "critical" ? 95 : event.severity === "warning" ? 72 : 45,
    summary: event.conditionDescription,
  }));

  return formatDigest(walletAddress, scheduleMode, clusters);
}

