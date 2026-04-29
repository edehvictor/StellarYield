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

export interface ThresholdAdjustment {
  /** Previous threshold value */
  previousThreshold: number;
  /** New threshold value */
  newThreshold: number;
  /** Amount of change */
  delta: number;
  /** Source that triggered the adjustment */
  source: ThresholdSource;
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
  /** Reason for current threshold level */
  currentReason: string;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: AdaptiveThresholdConfig = {
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
      // Collect current system conditions
      const conditions = await this.collectSystemConditions();
      
      // Calculate required threshold
      const { threshold, reason, atSafetyFloor } = await this.calculateThreshold(conditions);
      
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
        currentReason: reason,
      };

      // Log adjustment if threshold changed
      if (currentState && currentState.currentThreshold !== adjustedThreshold) {
        const adjustment: ThresholdAdjustment = {
          previousThreshold: currentState.currentThreshold,
          newThreshold: adjustedThreshold,
          delta: adjustedThreshold - currentState.currentThreshold,
          source: this.determineAdjustmentSource(conditions),
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

    // Enforce safety floor
    const enforcedThreshold = Math.max(newThreshold, this.config.absoluteMinimum);

    const conditions = await this.collectSystemConditions();
    const previousState = this.getPreviousState();
    const previousThreshold = previousState?.currentThreshold || this.config.defaultThreshold;

    const adjustment: ThresholdAdjustment = {
      previousThreshold,
      newThreshold: enforcedThreshold,
      delta: enforcedThreshold - previousThreshold,
      source: "manual_override",
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
      atSafetyFloor: enforcedThreshold === this.config.absoluteMinimum,
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

      return {
        healthScore,
        volatilityIndex,
        providerReliability,
        activeIncidents,
        systemLoad,
        hoursSinceLastIncident,
      };
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
  }> {
    let threshold = this.config.defaultThreshold;
    const reasons: string[] = [];

    // Health-based adjustment
    if (conditions.healthScore < 80) {
      const healthPenalty = ((80 - conditions.healthScore) / 10) * this.config.healthDegradationPenalty;
      threshold += healthPenalty;
      reasons.push(`Health degradation: +${(healthPenalty * 100).toFixed(1)}%`);
    }

    if (conditions.healthScore < this.config.healthCriticalThreshold) {
      threshold += 0.10; // Additional penalty for critical health
      reasons.push("Critical health status: +10%");
    }

    // Volatility-based adjustment
    if (conditions.volatilityIndex > this.config.volatilityHighThreshold) {
      threshold += this.config.volatilityPenalty;
      reasons.push(`High volatility: +${(this.config.volatilityPenalty * 100).toFixed(1)}%`);
    }

    // Provider quality adjustment
    if (conditions.providerReliability < this.config.providerQualityLowThreshold) {
      threshold += this.config.providerQualityPenalty;
      reasons.push(`Poor provider quality: +${(this.config.providerQualityPenalty * 100).toFixed(1)}%`);
    }

    // Incident-based adjustment
    if (conditions.activeIncidents > 0) {
      const incidentPenalty = conditions.activeIncidents * this.config.incidentPenalty;
      threshold += incidentPenalty;
      reasons.push(`Active incidents (${conditions.activeIncidents}): +${(incidentPenalty * 100).toFixed(1)}%`);
    }

    // System load adjustment
    if (conditions.systemLoad > this.config.systemLoadHighThreshold) {
      threshold += this.config.systemLoadPenalty;
      reasons.push(`High system load: +${(this.config.systemLoadPenalty * 100).toFixed(1)}%`);
    }

    // Enforce bounds
    threshold = Math.max(this.config.absoluteMinimum, Math.min(this.config.maximumThreshold, threshold));
    
    const atSafetyFloor = threshold === this.config.absoluteMinimum;

    return {
      threshold: Math.round(threshold * 1000) / 1000,
      reason: reasons.length > 0 ? reasons.join("; ") : "Normal conditions",
      atSafetyFloor,
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
    return Date.now() - new Date(lastUpdated).getTime() < interval;
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
