export interface AlertPreferences {
  channel: "email" | "in_app";
  cooldownMinutes: number;
  severityThreshold: number;
  quietHoursStart: number;
  quietHoursEnd: number;
}

export interface AlertPreferencesValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: AlertPreferences;
}

/**
 * Validates and sanitizes alert preferences against strict numeric boundaries
 * and integer constraints. Preserves existing state on failure.
 */
export function validateAlertPreferences(raw: unknown): AlertPreferencesValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ["preferences must be an object"] };
  }

  const p = raw as Record<string, unknown>;

  if (p.channel !== "email" && p.channel !== "in_app") {
    errors.push("channel must be email or in_app");
  }

  const cooldown = Number(p.cooldownMinutes);
  if (!Number.isFinite(cooldown) || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 1440) {
    errors.push("cooldownMinutes must be an integer between 0 and 1440");
  }

  const severity = Number(p.severityThreshold);
  if (!Number.isFinite(severity) || severity < 0 || severity > 1000) {
    errors.push("severityThreshold must be a number between 0 and 1000");
  }

  const quietStart = Number(p.quietHoursStart);
  if (!Number.isFinite(quietStart) || !Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23) {
    errors.push("quietHoursStart must be an integer from 0 to 23");
  }

  const quietEnd = Number(p.quietHoursEnd);
  if (!Number.isFinite(quietEnd) || !Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23) {
    errors.push("quietHoursEnd must be an integer from 0 to 23");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const sanitized: AlertPreferences = {
    channel: p.channel as "email" | "in_app",
    cooldownMinutes: cooldown,
    severityThreshold: roundToDecimals(severity, 2),
    quietHoursStart: quietStart,
    quietHoursEnd: quietEnd,
  };

  return { valid: true, errors: [], sanitized };
}

export type AlertThresholdReasonCode =
  | "BASELINE_DEFAULT"
  | "HIGH_VOLATILITY_EXPANSION"
  | "LOW_VOLATILITY_TIGHTENING"
  | "BURST_TRIGGER_SUPPRESSION"
  | "HIGH_NOISE_DAMPENING"
  | "QUIET_HOURS_BUFFER"
  | "MIN_SEVERITY_FLOOR"
  | "MAX_SEVERITY_CEILING";

export const ALERT_THRESHOLD_REASON_DESCRIPTIONS: Record<AlertThresholdReasonCode, string> = {
  BASELINE_DEFAULT: "Baseline alert threshold and cooldown assigned under stable market conditions.",
  HIGH_VOLATILITY_EXPANSION: "Threshold expanded to reduce alert fatigue during high volatility.",
  LOW_VOLATILITY_TIGHTENING: "Threshold tightened to capture subtle APY changes in low volatility.",
  BURST_TRIGGER_SUPPRESSION: "Extended cooldown recommended due to frequent trigger burst history.",
  HIGH_NOISE_DAMPENING: "Increased severity threshold to filter out market noise.",
  QUIET_HOURS_BUFFER: "Cooldown adjusted to accommodate user quiet hours window.",
  MIN_SEVERITY_FLOOR: "Threshold bounded by minimum acceptable sensitivity floor.",
  MAX_SEVERITY_CEILING: "Threshold bounded by maximum severity ceiling.",
};

export interface AlertThresholdRecommendationInput {
  walletAddress?: string;
  vaultId?: string;
  historicalVolatility: number; // 0-100
  triggerFrequencyPerHour: number; // >= 0
  noiseIndex?: number; // 0-1
  apyDispersion?: number; // >= 0
  userQuietHoursSpan?: number; // hours
}

export interface AlertThresholdConfig {
  defaultSeverityThreshold: number; // e.g. 5.0 (%)
  minSeverityThreshold: number; // e.g. 1.0 (%)
  maxSeverityThreshold: number; // e.g. 25.0 (%)
  defaultCooldownMinutes: number; // e.g. 60
  minCooldownMinutes: number; // e.g. 15
  maxCooldownMinutes: number; // e.g. 1440
  volatilityHighThreshold: number; // e.g. 50
  volatilityLowThreshold: number; // e.g. 15
  frequencyBurstThreshold: number; // e.g. 3 triggers/hour
}

export const DEFAULT_ALERT_THRESHOLD_CONFIG: AlertThresholdConfig = {
  defaultSeverityThreshold: 5.0,
  minSeverityThreshold: 1.0,
  maxSeverityThreshold: 25.0,
  defaultCooldownMinutes: 60,
  minCooldownMinutes: 15,
  maxCooldownMinutes: 1440, // 24 hours
  volatilityHighThreshold: 50,
  volatilityLowThreshold: 15,
  frequencyBurstThreshold: 3,
};

export interface AlertThresholdRecommendation {
  walletAddress?: string;
  vaultId?: string;
  recommendedSeverityThreshold: number;
  recommendedCooldownMinutes: number;
  baselineSeverityThreshold: number;
  baselineCooldownMinutes: number;
  primaryReasonCode: AlertThresholdReasonCode;
  reasonCodes: AlertThresholdReasonCode[];
  reason: string;
  normalizedInputs: AlertThresholdRecommendationInput;
  timestamp: string;
}

/**
 * Documented rounding utility enforcing half-up rounding and normalizing -0 to 0.
 */
export function roundToDecimals(val: number, decimals: number): number {
  if (!Number.isFinite(val)) return 0;
  const factor = 10 ** decimals;
  const res = Math.round((val + Number.EPSILON) * factor) / factor;
  return Object.is(res, -0) ? 0 : res;
}

/**
 * Normalizes alert recommendation inputs to ensure determinism and jitter-free evaluation.
 */
export function normalizeAlertThresholdInputs(
  raw?: Partial<AlertThresholdRecommendationInput>,
): AlertThresholdRecommendationInput {
  const sanitizeNumber = (
    val: unknown,
    min: number,
    max: number,
    defaultVal: number,
    decimals: number = 4,
  ): number => {
    if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val)) {
      return defaultVal;
    }
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    const clamped = Math.max(lower, Math.min(upper, val));
    return roundToDecimals(clamped, decimals);
  };

  return {
    walletAddress: raw?.walletAddress,
    vaultId: raw?.vaultId,
    historicalVolatility: sanitizeNumber(raw?.historicalVolatility, 0, 100, 30, 2),
    triggerFrequencyPerHour: sanitizeNumber(raw?.triggerFrequencyPerHour, 0, 1000, 0.5, 2),
    noiseIndex: sanitizeNumber(raw?.noiseIndex, 0, 1, 0.2, 4),
    apyDispersion: sanitizeNumber(raw?.apyDispersion, 0, 100, 1.0, 2),
    userQuietHoursSpan: sanitizeNumber(raw?.userQuietHoursSpan, 0, 24, 0, 1),
  };
}

// ── In-Memory Persistence Store ─────────────────────────────────────────

const alertRecommendationStore = new Map<string, AlertThresholdRecommendation[]>();

function getAlertStoreKey(walletAddress: string, vaultId: string): string {
  return `${walletAddress.toLowerCase()}::${vaultId.toLowerCase()}`;
}

export function saveAlertThresholdRecommendation(
  walletAddress: string,
  vaultId: string,
  rec: AlertThresholdRecommendation,
): void {
  const key = getAlertStoreKey(walletAddress, vaultId);
  const existing = alertRecommendationStore.get(key) ?? [];
  alertRecommendationStore.set(key, [rec, ...existing].slice(0, 50));
}

export function getAlertThresholdRecommendation(
  walletAddress: string,
  vaultId: string,
): AlertThresholdRecommendation | undefined {
  const key = getAlertStoreKey(walletAddress, vaultId);
  return alertRecommendationStore.get(key)?.[0];
}

export function getAlertThresholdRecommendationHistory(
  walletAddress: string,
  vaultId: string,
): AlertThresholdRecommendation[] {
  const key = getAlertStoreKey(walletAddress, vaultId);
  return alertRecommendationStore.get(key) ?? [];
}

export function resetAlertThresholdRecommendationStore(): void {
  alertRecommendationStore.clear();
}

/**
 * Deterministically generates an adaptive alert threshold recommendation based on normalized inputs.
 */
export function recommendAlertThreshold(
  rawInput?: Partial<AlertThresholdRecommendationInput>,
  configOverrides?: Partial<AlertThresholdConfig>,
): AlertThresholdRecommendation {
  const config = { ...DEFAULT_ALERT_THRESHOLD_CONFIG, ...configOverrides };
  const minSev = Math.min(config.minSeverityThreshold, config.maxSeverityThreshold);
  const maxSev = Math.max(config.minSeverityThreshold, config.maxSeverityThreshold);
  const minCool = Math.min(config.minCooldownMinutes, config.maxCooldownMinutes);
  const maxCool = Math.max(config.minCooldownMinutes, config.maxCooldownMinutes);

  const inputs = normalizeAlertThresholdInputs(rawInput);

  let severity = config.defaultSeverityThreshold;
  let cooldown = config.defaultCooldownMinutes;
  const reasonCodes: AlertThresholdReasonCode[] = [];
  const reasons: string[] = [];

  // Volatility adjustment
  if (inputs.historicalVolatility > config.volatilityHighThreshold) {
    const volHighDenom = Math.max(1, 100 - config.volatilityHighThreshold);
    const volExp = roundToDecimals(
      ((inputs.historicalVolatility - config.volatilityHighThreshold) / volHighDenom) * 5.0,
      2,
    );
    severity += volExp;
    reasons.push(`High market volatility (+${volExp.toFixed(1)}% threshold)`);
    reasonCodes.push("HIGH_VOLATILITY_EXPANSION");
  } else if (inputs.historicalVolatility < config.volatilityLowThreshold && config.volatilityLowThreshold > 0) {
    const volLowDenom = config.volatilityLowThreshold;
    const volTight = roundToDecimals(
      ((config.volatilityLowThreshold - inputs.historicalVolatility) / volLowDenom) * 1.5,
      2,
    );
    severity -= volTight;
    reasons.push(`Low volatility environment (-${volTight.toFixed(1)}% threshold)`);
    reasonCodes.push("LOW_VOLATILITY_TIGHTENING");
  }

  // Burst trigger suppression
  if (inputs.triggerFrequencyPerHour >= config.frequencyBurstThreshold && config.frequencyBurstThreshold > 0) {
    const burstMultiplier = Math.min(
      4,
      Math.floor(inputs.triggerFrequencyPerHour / config.frequencyBurstThreshold) + 1,
    );
    cooldown = cooldown * burstMultiplier;
    reasons.push(
      `Frequent trigger burst history (${inputs.triggerFrequencyPerHour}/hr -> ${cooldown}m cooldown)`,
    );
    reasonCodes.push("BURST_TRIGGER_SUPPRESSION");
  }

  // Noise dampening
  if (inputs.noiseIndex && inputs.noiseIndex > 0.5) {
    severity += 2.0;
    reasons.push("Noise dampening applied (+2.0% threshold)");
    reasonCodes.push("HIGH_NOISE_DAMPENING");
  }

  // Quiet hours buffer
  if (inputs.userQuietHoursSpan && inputs.userQuietHoursSpan >= 6) {
    cooldown = Math.max(cooldown, 120);
    reasonCodes.push("QUIET_HOURS_BUFFER");
  }

  // Clamp severity
  const unboundedSeverity = roundToDecimals(severity, 2);
  severity = Math.max(minSev, Math.min(maxSev, unboundedSeverity));
  severity = roundToDecimals(severity, 2);

  // Clamp cooldown
  cooldown = Math.max(minCool, Math.min(maxCool, cooldown));
  cooldown = Math.round(cooldown);

  if (unboundedSeverity < minSev) {
    reasonCodes.push("MIN_SEVERITY_FLOOR");
  }
  if (unboundedSeverity > maxSev) {
    reasonCodes.push("MAX_SEVERITY_CEILING");
  }

  if (reasonCodes.length === 0) {
    reasonCodes.push("BASELINE_DEFAULT");
  }

  const primaryReasonCode = reasonCodes[0];
  const reason = reasons.length > 0 ? reasons.join("; ") : "Baseline standard alert preferences";

  const recommendation: AlertThresholdRecommendation = {
    walletAddress: inputs.walletAddress,
    vaultId: inputs.vaultId,
    recommendedSeverityThreshold: severity,
    recommendedCooldownMinutes: cooldown,
    baselineSeverityThreshold: config.defaultSeverityThreshold,
    baselineCooldownMinutes: config.defaultCooldownMinutes,
    primaryReasonCode,
    reasonCodes,
    reason,
    normalizedInputs: inputs,
    timestamp: new Date().toISOString(),
  };

  if (inputs.walletAddress && inputs.vaultId) {
    saveAlertThresholdRecommendation(inputs.walletAddress, inputs.vaultId, recommendation);
  }

  return recommendation;
}

function inQuietHours(nowHourUtc: number, preferences: AlertPreferences): boolean {
  let { quietHoursStart, quietHoursEnd } = preferences;
  if (!Number.isFinite(quietHoursStart) || !Number.isFinite(quietHoursEnd)) {
    return false;
  }
  quietHoursStart = Math.floor(quietHoursStart) % 24;
  quietHoursEnd = Math.floor(quietHoursEnd) % 24;
  if (quietHoursStart < 0) quietHoursStart += 24;
  if (quietHoursEnd < 0) quietHoursEnd += 24;

  if (quietHoursStart === quietHoursEnd) return false;
  if (quietHoursStart < quietHoursEnd) {
    return nowHourUtc >= quietHoursStart && nowHourUtc < quietHoursEnd;
  }
  return nowHourUtc >= quietHoursStart || nowHourUtc < quietHoursEnd;
}

export function shouldSuppressAlert(
  now: Date,
  previousTriggeredAtMs: number | undefined,
  preferences: AlertPreferences,
): boolean {
  if (inQuietHours(now.getUTCHours(), preferences)) return true;
  if (
    previousTriggeredAtMs === undefined ||
    !Number.isFinite(previousTriggeredAtMs) ||
    previousTriggeredAtMs <= 0
  ) {
    return false;
  }
  if (!Number.isFinite(preferences.cooldownMinutes) || preferences.cooldownMinutes <= 0) {
    return false;
  }
  const nowMs = now.getTime();
  // Safe handling of clock skew / future timestamps
  if (nowMs < previousTriggeredAtMs) {
    return false;
  }
  const elapsedMs = nowMs - previousTriggeredAtMs;
  return elapsedMs < preferences.cooldownMinutes * 60_000;
}
