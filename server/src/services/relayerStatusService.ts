// ── Relayer Status Service ─────────────────────────────────────────────────
// Tracks bridge relayer health metrics: queue depth, replay protection,
// relay failures, and recent activity for the read-only status page.

export interface RelayEvent {
  id: string;
  timestamp: string;
  status: "success" | "failed" | "pending";
  innerTxHash?: string;
  feeBumpHash?: string;
  error?: string;
  durationMs: number;
}

export interface ReplayProtectionStatus {
  enabled: boolean;
  trackedHashes: number;
  oldestHashAge: string | null;
  deduplicationWindow: string;
}

export interface RelayerStatus {
  isOnline: boolean;
  network: string;
  queueDepth: number;
  totalRelayed: number;
  successCount: number;
  failureCount: number;
  successRate: number; // 0-100
  avgDurationMs: number;
  lastRelayAt: string | null;
  recentEvents: RelayEvent[];
  replayProtection: ReplayProtectionStatus;
  uptime: string;
  checkedAt: string;
}

// ── In-memory state ───────────────────────────────────────────────────────

const MAX_EVENTS = 100;
const DEDUP_WINDOW_HOURS = 24;

const events: RelayEvent[] = [];
const seenHashes = new Map<string, number>(); // hash -> timestamp ms
const seenFingerprints = new Map<string, number>(); // fingerprint -> timestamp ms
const startedAt = Date.now();

let pendingCount = 0;

// ── Public API ────────────────────────────────────────────────────────────

export function recordRelayStart(): string {
  const id = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingCount++;
  return id;
}

export function recordRelaySuccess(
  id: string,
  durationMs: number,
  innerTxHash?: string,
  feeBumpHash?: string,
): void {
  pendingCount = Math.max(0, pendingCount - 1);

  if (innerTxHash) {
    seenHashes.set(innerTxHash, Date.now());
  }
  if (feeBumpHash) {
    seenHashes.set(feeBumpHash, Date.now());
  }

  events.unshift({
    id,
    timestamp: new Date().toISOString(),
    status: "success",
    innerTxHash,
    feeBumpHash,
    durationMs,
  });

  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  pruneSeenHashes();
}

export function recordRelayFailure(id: string, durationMs: number, error: string): void {
  pendingCount = Math.max(0, pendingCount - 1);

  events.unshift({
    id,
    timestamp: new Date().toISOString(),
    status: "failed",
    error,
    durationMs,
  });

  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

export function isHashSeen(hash: string): boolean {
  return seenHashes.has(hash);
}

/**
 * Deterministic transaction fingerprint tracking (#1319).
 *
 * Complements the raw-XDR hash replay protection above: two submissions
 * with different XDR encodings but the same semantic fields (sender,
 * receiver, amount, asset, memo/nonce, timestamp bucket) will share a
 * fingerprint and be flagged as duplicates.
 */
export function isFingerprintSeen(fingerprint: string): boolean {
  pruneSeenFingerprints();
  return seenFingerprints.has(fingerprint);
}

export function recordFingerprint(fingerprint: string): void {
  seenFingerprints.set(fingerprint, Date.now());
}

export function getRelayerStatus(): RelayerStatus {
  pruneSeenHashes();

  const successCount = events.filter((e) => e.status === "success").length;
  const failureCount = events.filter((e) => e.status === "failed").length;
  const totalRelayed = successCount + failureCount;
  const successRate = totalRelayed > 0 ? Math.round((successCount / totalRelayed) * 100) : 100;

  const durations = events
    .filter((e) => e.status === "success")
    .map((e) => e.durationMs);
  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

  const lastRelayAt = events.length > 0 ? events[0].timestamp : null;

  // Uptime since service started
  const uptimeMs = Date.now() - startedAt;
  const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

  // Replay protection
  const now = Date.now();
  const cutoff = now - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;
  let oldestHashAge: string | null = null;
  let oldestTs = now;

  for (const [, ts] of seenHashes) {
    if (ts < oldestTs) oldestTs = ts;
  }

  if (seenHashes.size > 0) {
    const ageMs = now - oldestTs;
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    oldestHashAge = ageMinutes < 60 ? `${ageMinutes}m` : `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m`;
  }

  return {
    isOnline: true,
    network: process.env.NETWORK_PASSPHRASE?.includes("TESTNET") ? "testnet" : "mainnet",
    queueDepth: pendingCount,
    totalRelayed,
    successCount,
    failureCount,
    successRate,
    avgDurationMs,
    lastRelayAt,
    recentEvents: events.slice(0, 20),
    replayProtection: {
      enabled: true,
      trackedHashes: seenHashes.size,
      oldestHashAge,
      deduplicationWindow: `${DEDUP_WINDOW_HOURS}h`,
    },
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    checkedAt: new Date().toISOString(),
  };
}

// ── Internal ──────────────────────────────────────────────────────────────

function pruneSeenHashes(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;
  for (const [hash, ts] of seenHashes) {
    if (ts < cutoff) seenHashes.delete(hash);
  }
}

function pruneSeenFingerprints(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;
  for (const [fingerprint, ts] of seenFingerprints) {
    if (ts < cutoff) seenFingerprints.delete(fingerprint);
  }
}
