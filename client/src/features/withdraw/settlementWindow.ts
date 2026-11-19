export interface SettlementWindowStatus {
  state: "pending" | "elapsed";
  remainingSeconds: number;
}

export function getSettlementWindowStatus(
  estimatedReadyAtMs: number,
  nowMs: number,
): SettlementWindowStatus {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((estimatedReadyAtMs - nowMs) / 1000),
  );

  return {
    state: remainingSeconds > 0 ? "pending" : "elapsed",
    remainingSeconds,
  };
}

export function formatSettlementTimeRemaining(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
