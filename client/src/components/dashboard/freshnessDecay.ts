export type DecayCurve = "linear" | "exponential" | "stepwise";

export interface FreshnessPolicy {
  curve: DecayCurve;
  freshWindowMs: number;
  softStaleMs: number;
  hardStaleMs: number;
  decayK?: number;
}

export const DEFAULT_UI_FRESHNESS_POLICY: FreshnessPolicy = {
  curve: "exponential",
  freshWindowMs: 60_000,
  softStaleMs: 10 * 60_000,
  hardStaleMs: 45 * 60_000,
  decayK: 3.5,
};

export function computeDecayedFreshnessConfidence(ageMs: number, policy: FreshnessPolicy = DEFAULT_UI_FRESHNESS_POLICY): { confidence: number; unusable: boolean } {
  if (ageMs <= policy.freshWindowMs) return { confidence: 1, unusable: false };
  if (ageMs >= policy.hardStaleMs) return { confidence: 0, unusable: true };

  const normalized = Math.max(0, Math.min(1, (ageMs - policy.freshWindowMs) / (policy.softStaleMs - policy.freshWindowMs || 1)));

  let confidence = 1;
  if (policy.curve === "linear") confidence = 1 - normalized;
  else if (policy.curve === "stepwise") confidence = normalized < 0.33 ? 0.85 : normalized < 0.66 ? 0.55 : 0.25;
  else confidence = Math.exp(-(policy.decayK ?? 3.5) * normalized);

  return { confidence: Math.max(0, Math.min(1, confidence)), unusable: false };
}
