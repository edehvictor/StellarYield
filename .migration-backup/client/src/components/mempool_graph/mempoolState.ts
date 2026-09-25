export type MempoolTxState = "healthy" | "delayed" | "stalled";

export interface LatencyBucket {
  label: "fast" | "normal" | "slow";
  maxAgeMs: number;
}

export const LATENCY_BUCKETS: LatencyBucket[] = [
  { label: "fast", maxAgeMs: 5_000 },
  { label: "normal", maxAgeMs: 30_000 },
  { label: "slow", maxAgeMs: 120_000 },
];

export const STALLED_THRESHOLD_MS = 120_000;
export const DELAYED_THRESHOLD_MS = 30_000;

export function classifyTxState(ageMs: number): MempoolTxState {
  if (ageMs >= STALLED_THRESHOLD_MS) return "stalled";
  if (ageMs >= DELAYED_THRESHOLD_MS) return "delayed";
  return "healthy";
}

export function getLatencyBucket(ageMs: number): string {
  for (const bucket of LATENCY_BUCKETS) {
    if (ageMs <= bucket.maxAgeMs) return bucket.label;
  }
  return "stalled";
}

export interface MempoolTxWithState {
  id: string;
  ageMs: number;
  state: MempoolTxState;
  latencyBucket: string;
  resubmissionCount: number;
}

export function buildTxWithState(
  id: string,
  ageMs: number,
  resubmissionCount = 0,
): MempoolTxWithState {
  return {
    id,
    ageMs,
    state: classifyTxState(ageMs),
    latencyBucket: getLatencyBucket(ageMs),
    resubmissionCount,
  };
}

export function isStalledWithResubmission(tx: MempoolTxWithState): boolean {
  return tx.state === "stalled" && tx.resubmissionCount > 0;
}

export function partitionByState(txs: MempoolTxWithState[]): {
  healthy: MempoolTxWithState[];
  delayed: MempoolTxWithState[];
  stalled: MempoolTxWithState[];
} {
  return {
    healthy: txs.filter((t) => t.state === "healthy"),
    delayed: txs.filter((t) => t.state === "delayed"),
    stalled: txs.filter((t) => t.state === "stalled"),
  };
}
