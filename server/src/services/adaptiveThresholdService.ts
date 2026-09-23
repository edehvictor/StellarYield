/**
 * Adaptive Strategy Confidence Threshold Controller (#391)
 *
 * Dynamically adjusts the minimum confidence required for recommendations
 * based on system conditions including health, volatility, and provider quality.
 *
 * SECURITY: Threshold adaptation always preserves strict minimum safety floors.
 */

import NodeCache from "node-cache";
import { freezeService } from "./freezeService";
import { strategyHealthEngine as _strategyHealthEngine, StrategyHealthScore as _StrategyHealthScore } from "./strategyHealthService";
import { yieldReliabilityEngine as _yieldReliabilityEngine, DataSourceReliability as _DataSourceReliability } from "./yieldReliabilityService";

// ── Types ───────────────────────────────────────────────────────────────

export type ThresholdSource = "health" | "volatility" | "provider_quality" | "market_conditions" | "manual_override";

export type AdaptiveThresholdReasonCode =
  | "NORMAL_CONDITIONS"
  | "HEALTH_DEGRADATION"
  | "HEALTH_CRITICAL"
  | "HIGH_VOLATILITY"
  | "POOR_PROVIDER_QUALITY"
  | "ACTIVE_INCIDENTS"
  | "HIGH_SYSTEM_LOAD"
  | "SAFETY_FLOOR_ENFORCED"
  | "MAX_THRESHOLD_ENFORCED"
  | "MANUAL_OVERRIDE"
  | "FALLBACK_DEFAULT";

export const ADAPTIVE_THRESHOLD_REASON_DESCRIPTIONS: Record<AdaptiveThresholdReasonCode, string> = {
  NORMAL_CONDITIONS: "System conditions are within standard operational parameters.",
  HEALTH_DEGRADATION: "Threshold increased due to degraded system health score below 80.",
  HEALTH_CRITICAL: "Critical health penalty applied due to health score falling below critical threshold.",
  HIGH_VOLATILITY: "Elevated market volatility triggered confidence threshold expansion.",
  POOR_PROVIDER_QUALITY: "Average provider reliability below acceptable quality threshold.",
  ACTIVE_INCIDENTS: "Active risk/operational incidents necessitated higher confidence requirement.",
  HIGH_SYSTEM_LOAD: "Elevated infrastructure system load applied protective penalty.",
  SAFETY_FLOOR_ENFORCED: "Calculated threshold bounded by absolute safety floor.",
  MAX_THRESHOLD_ENFORCED: "Calculated threshold bounded by maximum configured ceiling.",
  MANUAL_OVERRIDE: "Threshold manually overridden with safety limits.",
  FALLBACK_DEFAULT: "Fallback to default threshold due to an evaluation error.",
};

export interface ThresholdAdjustment {
  /** Previous threshold value */
  previousThreshold: number;
  /** New threshold value */
  newThreshold: number;
  /** Amount of change */
  delta: number;
  /** Source that triggered the adjustment */
  source: ThresholdSource;
  /** Primary reason code */
  reasonCode?: AdaptiveThresholdReasonCode;
  /** All applicable reason codes */
  reasonCodes?: AdaptiveThresholdReasonCode[];
  /** Reason for adjustment */
  reason: string;
  /** Timestamp of adjustment */
  timestamp: string;
  /** System conditions at time of adjustment */
  conditions: SystemConditions;
}

export interface SystemConditions {
  /** Overall system health score (0-100) */
  healthScore: number;
  /** Market volatility index (0-1, higher = more volatile) */
  volatilityIndex: number;
  /** Average provider reliability score (0-100) */
  providerReliability: number;
  /** Number of active incidents */
  activeIncidents: number;
  /** System load factor (0-1) */
  systemLoad: number;
  /** Time since last major incident (hours) */
  hoursSinceLastIncident: number;
}

export interface AdaptiveThresholdConfig {
  /** Absolute minimum threshold (safety floor) - never goes below this */
  absoluteMinimum: number;
  /** Default threshold when all conditions are normal */
  defaultThreshold: number;
  /** Maximum threshold during extreme conditions */
  maximumThreshold: number;
  
  // Health-based adjustments
  healthDegradationPenalty: number; // Penalty per 10-point health decrease
  healthCriticalThreshold: number; // Health score below which max penalty applies
  
  // Volatility-based adjustments
  volatilityLowThreshold: number; // Below this = low volatility
  volatilityHighThreshold: number; // Above this = high volatility
  volatilityPenalty: number; // Penalty for high volatility
  
  // Provider quality adjustments
  providerQualityLowThreshold: number; // Below this = poor provider quality
  providerQualityPenalty: number; // Penalty for poor provider quality
  
  // Market condition adjustments
  incidentPenalty: number; // Penalty per active incident
  systemLoadHighThreshold: number; // Above this = high load
  systemLoadPenalty: number; // Penalty for high system load
  
  // Threshold change limits
  maxSingleAdjustment: number; // Maximum change in one adjustment
  minAdjustmentIntervalMinutes: number; // Minimum time between adjustments
  
  // Logging and audit
  enableAuditLogging: boolean;
  cacheMinutes: number;
}

export interface ThresholdState {
  /** Current active threshold */
  currentThreshold: number;
  /** When threshold was last updated */
  lastUpdated: string;
  /** History of adjustments */
  adjustmentHistory: ThresholdAdjustment[];
  /** Current system conditions */
  conditions: SystemConditions;
  /** Whether threshold is at safety floor */
  atSafetyFloor: boolean;
  /** Primary reason code for current threshold level */
  reasonCode?: AdaptiveThresholdReasonCode;
  /** All reason codes for current threshold level */
  reasonCodes?: AdaptiveThresholdReasonCode[];
  /** Reason for current threshold level */
  currentReason: string;
}

export interface ThresholdRecommendation {
  recommendedThreshold: number;
  baselineThreshold: number;
  primaryReasonCode: AdaptiveThresholdReasonCode;
  reasonCodes: AdaptiveThresholdReasonCode[];
  reason: string;
  atSafetyFloor: boolean;
  atCeiling: boolean;
  normalizedConditions: SystemConditions;
  penalties: {
    healthPenalty: number;
    healthCriticalPenalty: number;
    volatilityPenalty: number;
    providerQualityPenalty: number;
    incidentPenalty: number;
    systemLoadPenalty: number;
    totalPenalty: number;
  };
  timestamp: string;
}

// ── Normalization and Recommendation Utilities ──────────────────────────

function roundToPrecision(value: number, decimals: number = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Normalizes system conditions before scoring.
 * Clamps values to valid physical bounds and rounds floating point numbers
 * to eliminate jitter across repeated calculations.
 */
export function normalizeSystemConditions(raw?: Partial<SystemConditions>): SystemConditions {
  const fallback: SystemConditions = {
    healthScore: 85,
    volatilityIndex: 0.30,
    providerReliability: 80,
    activeIncidents: 0,
    systemLoad: 0.65,
    hoursSinceLastIncident: 168,
  };

  if (!raw) return { ...fallback };

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
    const clamped = Math.max(min, Math.min(max, val));
    return roundToPrecision(clamped, decimals);
  };

  const sanitizeInt = (val: unknown, min: number, max: number, defaultVal: number): number => {
    if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val)) {
      return defaultVal;
    }
    const rounded = Math.round(val);
    return Math.max(min, Math.min(max, rounded));
  };

  return {
    healthScore: sanitizeNumber(raw.healthScore, 0, 100, fallback.healthScore, 2),
    volatilityIndex: sanitizeNumber(raw.volatilityIndex, 0, 1, fallback.volatilityIndex, 4),
    providerReliability: sanitizeNumber(raw.providerReliability, 0, 100, fallback.providerReliability, 2),
    activeIncidents: sanitizeInt(raw.activeIncidents, 0, 1000, fallback.activeIncidents),
    systemLoad: sanitizeNumber(raw.systemLoad, 0, 1, fallback.systemLoad, 4),
    hoursSinceLastIncident: sanitizeNumber(raw.hoursSinceLastIncident, 0, 100000, fallback.hoursSinceLastIncident, 2),
  };
}

// ── Configuration ───────────────────────────────────────────────────────

export const DEFAULT_THRESHOLD_CONFIG: AdaptiveThresholdConfig = {
  // Core thresholds
  absoluteMinimum: 0.60, // NEVER go below 60% confidence
  defaultThreshold: 0.75, // 75% confidence in normal conditions
  maximumThreshold: 0.95, // 95% confidence in extreme conditions
  
  // Health-based adjustments
  healthDegradationPenalty: 0.03, // +3% threshold per 10-point health decrease
  healthCriticalThreshold: 50, // Below 50 health score = critical
  
  // Volatility-based adjustments
  volatilityLowThreshold: 0.20,
  volatilityHighThreshold: 0.50,
  volatilityPenalty: 0.08, // +8% threshold for high volatility
  
  // Provider quality adjustments
  providerQualityLowThreshold: 70,
  providerQualityPenalty: 0.06, // +6% threshold for poor providers
  
  // Market condition adjustments
  incidentPenalty: 0.04, // +4% per active incident
  systemLoadHighThreshold: 0.80,
  systemLoadPenalty: 0.05, // +5% for high system load
  
  // Threshold change limits
  maxSingleAdjustment: 0.10, // Max 10% change at once
  minAdjustmentIntervalMinutes: 5,
  
  // Logging and audit
  enableAuditLogging: true,
  cacheMinutes: 5,
};

const DEFAULT_CONFIG: AdaptiveThresholdConfig = DEFAULT_THRESHOLD_CONFIG;

// ── Deterministic Recommendation Scoring Function ───────────────────────

/**
 * Pure deterministic threshold recommendation function.
 * Normalizes input conditions and produces an identical recommendation,
 * penalties breakdown, and reason codes for identical inputs.
 */
export function recommendThreshold(
  rawConditions?: Partial<SystemConditions>,
  configOverrides?: Partial<AdaptiveThresholdConfig>,
): ThresholdRecommendation {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const conditions = normalizeSystemConditions(rawConditions);

  let threshold = config.defaultThreshold;
  const reasons: string[] = [];
  const reasonCodes: AdaptiveThresholdReasonCode[] = [];

  let healthPenalty = 0;
  let healthCriticalPenalty = 0;
  let volatilityPenalty = 0;
  let providerQualityPenalty = 0;
  let incidentPenalty = 0;
  let systemLoadPenalty = 0;

  // Health-based adjustment
  if (conditions.healthScore < 80) {
    healthPenalty = roundToPrecision(((80 - conditions.healthScore) / 10) * config.healthDegradationPenalty, 4);
    threshold += healthPenalty;
    reasons.push(`Health degradation: +${(healthPenalty * 100).toFixed(1)}%`);
    reasonCodes.push("HEALTH_DEGRADATION");
  }

  if (conditions.healthScore < config.healthCriticalThreshold) {
    healthCriticalPenalty = 0.10;
    threshold += healthCriticalPenalty;
    reasons.push("Critical health status: +10%");
    reasonCodes.push("HEALTH_CRITICAL");
  }

  // Volatility-based adjustment
  if (conditions.volatilityIndex > config.volatilityHighThreshold) {
    volatilityPenalty = roundToPrecision(config.volatilityPenalty, 4);
    threshold += volatilityPenalty;
    reasons.push(`High volatility: +${(config.volatilityPenalty * 100).toFixed(1)}%`);
    reasonCodes.push("HIGH_VOLATILITY");
  }

  // Provider quality adjustment
  if (conditions.providerReliability < config.providerQualityLowThreshold) {
    providerQualityPenalty = roundToPrecision(config.providerQualityPenalty, 4);
    threshold += providerQualityPenalty;
    reasons.push(`Poor provider quality: +${(config.providerQualityPenalty * 100).toFixed(1)}%`);
    reasonCodes.push("POOR_PROVIDER_QUALITY");
  }

  // Incident-based adjustment
  if (conditions.activeIncidents > 0) {
    incidentPenalty = roundToPrecision(conditions.activeIncidents * config.incidentPenalty, 4);
    threshold += incidentPenalty;
    reasons.push(`Active incidents (${conditions.activeIncidents}): +${(incidentPenalty * 100).toFixed(1)}%`);
    reasonCodes.push("ACTIVE_INCIDENTS");
  }

  // System load adjustment
  if (conditions.systemLoad > config.systemLoadHighThreshold) {
    systemLoadPenalty = roundToPrecision(config.systemLoadPenalty, 4);
    threshold += systemLoadPenalty;
    reasons.push(`High system load: +${(config.systemLoadPenalty * 100).toFixed(1)}%`);
    reasonCodes.push("HIGH_SYSTEM_LOAD");
  }

  const unboundedThreshold = threshold;
  const atSafetyFloor = unboundedThreshold <= config.absoluteMinimum;
  const atCeiling = unboundedThreshold >= config.maximumThreshold;

  // Enforce bounds
  threshold = Math.max(config.absoluteMinimum, Math.min(config.maximumThreshold, threshold));
  const finalThreshold = Math.round(threshold * 1000) / 1000;

  if (atSafetyFloor && unboundedThreshold < config.absoluteMinimum) {
    reasonCodes.push("SAFETY_FLOOR_ENFORCED");
  }
  if (atCeiling && unboundedThreshold > config.maximumThreshold) {
    reasonCodes.push("MAX_THRESHOLD_ENFORCED");
  }

  if (reasonCodes.length === 0) {
    reasonCodes.push("NORMAL_CONDITIONS");
  }

  const primaryReasonCode = reasonCodes[0];
  const reason = reasons.length > 0 ? reasons.join("; ") : "Normal conditions";

  return {
    recommendedThreshold: finalThreshold,
    baselineThreshold: config.defaultThreshold,
    primaryReasonCode,
    reasonCodes,
    reason,
    atSafetyFloor: finalThreshold === config.absoluteMinimum,
    atCeiling: finalThreshold === config.maximumThreshold,
    normalizedConditions: conditions,
    penalties: {
      healthPenalty,
      healthCriticalPenalty,
      volatilityPenalty,
      providerQualityPenalty,
      incidentPenalty,
      systemLoadPenalty,
      totalPenalty: roundToPrecision(
        healthPenalty + healthCriticalPenalty + volatilityPenalty + providerQualityPenalty + incidentPenalty + systemLoadPenalty,
        4,
      ),
    },
    timestamp: new Date().toISOString(),
  };
}

// ── In-Memory Recommendation Persistence Store ──────────────────────────

const recommendationStore = new Map<string, ThresholdRecommendation[]>();

export function saveThresholdRecommendation(key: string, rec: ThresholdRecommendation): void {
  const existing = recommendationStore.get(key) ?? [];
  recommendationStore.set(key, [rec, ...existing].slice(0, 50));
}

export function getLatestThresholdRecommendation(key: string): ThresholdRecommendation | undefined {
  return recommendationStore.get(key)?.[0];
}

export function getThresholdRecommendationHistory(key: string): ThresholdRecommendation[] {
  return recommendationStore.get(key) ?? [];
}

export function resetThresholdRecommendationStore(): void {
  recommendationStore.clear();
}

const cache = new NodeCache({
  stdTTL: DEFAULT_CONFIG.cacheMinutes * 60,
  checkperiod: 60,
  useClones: false,
});

// ── Adaptive Threshold Controller ───────────────────────────────────────

export class AdaptiveThresholdController {
  private config: AdaptiveThresholdConfig;
  private adjustmentLog: ThresholdAdjustment[];
  private lastAdjustmentTime: Date | null;

  constructor(config: Partial<AdaptiveThresholdConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adjustmentLog = [];
    this.lastAdjustmentTime = null;
  }

  /**
   * Get current adaptive threshold based on system conditions
   */
  async getCurrentThreshold(): Promise<ThresholdState> {
    const cacheKey = "adaptive_threshold:current";
    const cached = cache.get<ThresholdState>(cacheKey);
    
    if (cached && !this.isStateStale(cached.lastUpdated)) {
      return cached;
    }

    if (freezeService.isFrozen()) {
      throw new Error("Adaptive threshold service is frozen");
    }

    try {
      // Collect current system conditions and normalize them
      const rawConditions = await this.collectSystemConditions();
      const conditions = normalizeSystemConditions(rawConditions);
      
      // Calculate required threshold
      const { threshold, reason, atSafetyFloor, reasonCode, reasonCodes } = await this.calculateThreshold(conditions);
      
      // Check if adjustment is needed
      const currentState = this.getPreviousState();
      const adjustedThreshold = this.applyAdjustmentLimits(
        currentState?.currentThreshold || this.config.defaultThreshold,
        threshold,
      );

      const newState: ThresholdState = {
        currentThreshold: adjustedThreshold,
        lastUpdated: new Date().toISOString(),
        adjustmentHistory: this.adjustmentLog.slice(-50), // Keep last 50 adjustments
        conditions,
        atSafetyFloor,
        reasonCode,
        reasonCodes,
        currentReason: reason,
      };

      // Log adjustment if threshold changed
      if (currentState && currentState.currentThreshold !== adjustedThreshold) {
        const adjustment: ThresholdAdjustment = {
          previousThreshold: currentState.currentThreshold,
          newThreshold: adjustedThreshold,
          delta: adjustedThreshold - currentState.currentThreshold,
          source: this.determineAdjustmentSource(conditions),
          reasonCode,
          reasonCodes,
          reason,
          timestamp: new Date().toISOString(),
          conditions,
        };
        
        this.adjustmentLog.push(adjustment);
        
        if (this.config.enableAuditLogging) {
          this.logAdjustment(adjustment);
        }
      }

      this.lastAdjustmentTime = new Date();
      cache.set(cacheKey, newState);

      return newState;
    } catch (error) {
      console.error("Failed to calculate adaptive threshold:", error);
      
      // Return safe default on error
      return {
        currentThreshold: this.config.defaultThreshold,
        lastUpdated: new Date().toISOString(),
        adjustmentHistory: this.adjustmentLog.slice(-50),
        conditions: await this.getFallbackConditions(),
        atSafetyFloor: false,
        reasonCode: "FALLBACK_DEFAULT",
        reasonCodes: ["FALLBACK_DEFAULT"],
        currentReason: "Fallback to default threshold due to error",
      };
    }
  }

  /**
   * Check if a confidence score meets the current threshold
   */
  async meetsThreshold(confidenceScore: number): Promise<{
    meets: boolean;
    currentThreshold: number;
    margin: number;
  }> {
    const state = await this.getCurrentThreshold();
    const margin = confidenceScore - state.currentThreshold;
    
    return {
      meets: confidenceScore >= state.currentThreshold,
      currentThreshold: state.currentThreshold,
      margin: Math.round(margin * 1000) / 1000,
    };
  }

  /**
   * Manually override threshold (with safety floor enforcement)
   */
  async manualOverride(newThreshold: number, reason: string): Promise<ThresholdState> {
    if (freezeService.isFrozen()) {
      throw new Error("Adaptive threshold service is frozen");
    }

    const conditions = await this.collectSystemConditions();
    const previousState = this.getPreviousState();
    const previousThreshold = previousState?.currentThreshold || this.config.defaultThreshold;

    // Enforce maxSingleAdjustment limit then safety floor
    const maxChange = this.config.maxSingleAdjustment;
    const clampedThreshold = Math.min(
      Math.max(newThreshold, previousThreshold - maxChange),
      previousThreshold + maxChange
    );
    const enforcedThreshold = Math.max(clampedThreshold, this.config.absoluteMinimum);

    const adjustment: ThresholdAdjustment = {
      previousThreshold,
      newThreshold: enforcedThreshold,
      delta: enforcedThreshold - previousThreshold,
      source: "manual_override",
      reasonCode: "MANUAL_OVERRIDE",
      reasonCodes: ["MANUAL_OVERRIDE"],
      reason: `Manual override: ${reason}`,
      timestamp: new Date().toISOString(),
      conditions,
    };

    this.adjustmentLog.push(adjustment);
    
    if (this.config.enableAuditLogging) {
      console.log("[AUDIT] Manual threshold override:", adjustment);
    }

    const newState: ThresholdState = {
      currentThreshold: enforcedThreshold,
      lastUpdated: new Date().toISOString(),
      adjustmentHistory: this.adjustmentLog.slice(-50),
      conditions,
      atSafetyFloor: newThreshold <= this.config.absoluteMinimum || enforcedThreshold === this.config.absoluteMinimum,
      reasonCode: "MANUAL_OVERRIDE",
      reasonCodes: ["MANUAL_OVERRIDE"],
      currentReason: reason,
    };

    cache.set("adaptive_threshold:current", newState);
    this.lastAdjustmentTime = new Date();

    return newState;
  }

  /**
   * Get adjustment history for audit/review
   */
  getAdjustmentHistory(limit: number = 50): ThresholdAdjustment[] {
    return this.adjustmentLog.slice(-limit);
  }

  /**
   * Get current configuration
   */
  getConfig(): AdaptiveThresholdConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<AdaptiveThresholdConfig>): void {
    // Enforce safety floor in config
    if (newConfig.absoluteMinimum !== undefined) {
      if (newConfig.absoluteMinimum < 0.50) {
        throw new Error("Absolute minimum threshold cannot be below 0.50 (50%)");
      }
      if (newConfig.absoluteMinimum > this.config.defaultThreshold) {
        throw new Error("Absolute minimum cannot exceed default threshold");
      }
    }

    this.config = { ...this.config, ...newConfig };
    cache.flushAll();
  }

  /**
   * Clear cache and reset state
   */
  reset(): void {
    cache.flushAll();
    this.adjustmentLog = [];
    this.lastAdjustmentTime = null;
  }

  // ── Private Methods ───────────────────────────────────────────────────

  /**
   * Collect current system conditions
   */
  private async collectSystemConditions(): Promise<SystemConditions> {
    try {
      // Get system health (mock - would integrate with monitoring)
      const healthScore = await this.getSystemHealthScore();
      
      // Get market volatility (mock - would integrate with market data)
      const volatilityIndex = await this.getMarketVolatilityIndex();
      
      // Get provider reliability
      const providerReliability = await this.getAverageProviderReliability();
      
      // Get active incidents (mock - would integrate with incident service)
      const activeIncidents = await this.getActiveIncidentCount();
      
      // Get system load (mock - would integrate with infrastructure monitoring)
      const systemLoad = await this.getSystemLoad();
      
      // Get time since last incident
      const hoursSinceLastIncident = await this.getHoursSinceLastIncident();

      return normalizeSystemConditions({
        healthScore,
        volatilityIndex,
        providerReliability,
        activeIncidents,
        systemLoad,
        hoursSinceLastIncident,
      });
    } catch (error) {
      console.error("Failed to collect system conditions:", error);
      return this.getFallbackConditions();
    }
  }

  /**
   * Calculate threshold based on conditions
   */
  private async calculateThreshold(conditions: SystemConditions): Promise<{
    threshold: number;
    reason: string;
    atSafetyFloor: boolean;
    reasonCode: AdaptiveThresholdReasonCode;
    reasonCodes: AdaptiveThresholdReasonCode[];
  }> {
    const rec = recommendThreshold(conditions, this.config);
    return {
      threshold: rec.recommendedThreshold,
      reason: rec.reason,
      atSafetyFloor: rec.atSafetyFloor,
      reasonCode: rec.primaryReasonCode,
      reasonCodes: rec.reasonCodes,
    };
  }

  /**
   * Apply adjustment limits to prevent sudden changes
   */
  private applyAdjustmentLimits(previousThreshold: number, newThreshold: number): number {
    const maxChange = this.config.maxSingleAdjustment;
    const delta = newThreshold - previousThreshold;

    // Limit single adjustment magnitude
    if (Math.abs(delta) > maxChange) {
      return previousThreshold + (delta > 0 ? maxChange : -maxChange);
    }

    // Enforce absolute minimum (safety floor)
    return Math.max(newThreshold, this.config.absoluteMinimum);
  }

  /**
   * Determine what triggered the adjustment
   */
  private determineAdjustmentSource(conditions: SystemConditions): ThresholdSource {
    // Priority order: health > volatility > provider quality > market conditions
    if (conditions.healthScore < 60) return "health";
    if (conditions.volatilityIndex > this.config.volatilityHighThreshold) return "volatility";
    if (conditions.providerReliability < this.config.providerQualityLowThreshold) return "provider_quality";
    return "market_conditions";
  }

  /**
   * Get previous threshold state
   */
  private getPreviousState(): ThresholdState | undefined {
    return cache.get<ThresholdState>("adaptive_threshold:current");
  }

  /**
   * Check if state is stale
   */
  private isStateStale(lastUpdated: string): boolean {
    const interval = this.config.minAdjustmentIntervalMinutes * 60 * 1000;
    return Date.now() - new Date(lastUpdated).getTime() > interval;
  }

  /**
   * Log adjustment for audit trail
   */
  private logAdjustment(adjustment: ThresholdAdjustment): void {
    console.log("[AUDIT] Threshold Adjustment:", {
      timestamp: adjustment.timestamp,
      source: adjustment.source,
      previous: adjustment.previousThreshold,
      new: adjustment.newThreshold,
      delta: adjustment.delta,
      reason: adjustment.reason,
    });
  }

  // ── Mock Data Fetchers (would integrate with real services) ───────────

  private async getSystemHealthScore(): Promise<number> {
    // Mock implementation - would query strategy health service
    return 85;
  }

  private async getMarketVolatilityIndex(): Promise<number> {
    // Mock implementation - would query market data
    return 0.30;
  }

  private async getAverageProviderReliability(): Promise<number> {
    // Mock implementation - would query yield reliability service
    return 80;
  }

  private async getActiveIncidentCount(): Promise<number> {
    // Mock implementation - would query incident service
    return 0;
  }

  private async getSystemLoad(): Promise<number> {
    // Mock implementation - would query infrastructure monitoring
    return 0.65;
  }

  private async getHoursSinceLastIncident(): Promise<number> {
    // Mock implementation - would query incident history
    return 168; // 7 days
  }

  private async getFallbackConditions(): Promise<SystemConditions> {
    return {
      healthScore: 75,
      volatilityIndex: 0.30,
      providerReliability: 75,
      activeIncidents: 0,
      systemLoad: 0.50,
      hoursSinceLastIncident: 24,
    };
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const adaptiveThresholdController = new AdaptiveThresholdController();

// ── Helper Functions ─────────────────────────────────────────────────────

/**
 * Format threshold state for API response
 */
export function formatThresholdState(state: ThresholdState): ThresholdState {
  return {
    ...state,
    currentThreshold: Math.round(state.currentThreshold * 1000) / 1000,
    adjustmentHistory: state.adjustmentHistory.map(adjustment => ({
      ...adjustment,
      previousThreshold: Math.round(adjustment.previousThreshold * 1000) / 1000,
      newThreshold: Math.round(adjustment.newThreshold * 1000) / 1000,
      delta: Math.round(adjustment.delta * 1000) / 1000,
    })),
  };
}

/**
 * Check if threshold change is significant (>5%)
 */
export function isSignificantThresholdChange(delta: number): boolean {
  return Math.abs(delta) > 0.05;
}
