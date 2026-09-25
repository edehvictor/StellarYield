/**
 * Centralized risk level configuration and explanations.
 * Used across dashboard and AI advisor components for consistent messaging.
 */

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface RiskLevelConfig {
    color: string;
    bg: string;
    border: string;
    order: number;
    explanation: string;
}

export const RISK_EXPLANATIONS: Record<RiskLevel, RiskLevelConfig> = {
    Low: {
        color: 'text-green-400',
        bg: 'bg-green-500/15',
        border: 'border-green-500/30',
        order: 1,
        explanation: 'High TVL, battle-tested protocol, highly liquid.',
    },
    Medium: {
        color: 'text-yellow-400',
        bg: 'bg-yellow-500/15',
        border: 'border-yellow-500/30',
        order: 2,
        explanation: 'Moderate volatility or newer protocol with steady growth.',
    },
    High: {
        color: 'text-red-400',
        bg: 'bg-red-500/15',
        border: 'border-red-500/30',
        order: 3,
        explanation: 'Low TVL, highly volatile assets, or experimental protocol.',
    },
};

export function getRiskConfig(level: RiskLevel): RiskLevelConfig {
    return RISK_EXPLANATIONS[level];
}

export function getRiskExplanation(level: RiskLevel): string {
    return RISK_EXPLANATIONS[level].explanation;
}

/**
 * Oracle metadata types and configurations.
 */

export type OracleSource = 'fresh' | 'twap_fallback' | 'unavailable';

export interface OracleMetadata {
    source: OracleSource;
    ageSeconds: number | null;
    confidence: number; // 0-100
    sampleCount?: number;
}

export interface OracleStatusConfig {
    badge: string;
    color: string;
    bg: string;
    explanation: string;
}

export const ORACLE_STATUS_CONFIG: Record<OracleSource, OracleStatusConfig> = {
    fresh: {
        badge: '✓ Fresh Data',
        color: 'text-green-400',
        bg: 'bg-green-500/15',
        explanation: 'Real-time oracle data available.',
    },
    twap_fallback: {
        badge: '⚠ TWAP Fallback',
        color: 'text-yellow-400',
        bg: 'bg-yellow-500/15',
        explanation: 'Using time-weighted average price due to stale oracle data.',
    },
    unavailable: {
        badge: '✗ No Data',
        color: 'text-red-400',
        bg: 'bg-red-500/15',
        explanation: 'Oracle data unavailable. Operations may be restricted.',
    },
};

/**
 * Get oracle status configuration based on metadata.
 */
export function getOracleStatusConfig(metadata: OracleMetadata): OracleStatusConfig {
    return ORACLE_STATUS_CONFIG[metadata.source];
}

/**
 * Get confidence level badge color based on confidence score.
 */
export function getConfidenceBadgeColor(confidence: number): string {
    if (confidence >= 80) return 'text-green-400';
    if (confidence >= 60) return 'text-yellow-400';
    return 'text-red-400';
}

/**
 * Check if operations should be blocked based on oracle confidence.
 */
export function shouldBlockOperation(
    confidence: number,
    operationType: 'deposit' | 'withdraw' | 'rebalance' | 'liquidation'
): boolean {
    const minThresholds = {
        deposit: 60,
        withdraw: 60,
        rebalance: 75,
        liquidation: 85,
    };

    return confidence < minThresholds[operationType];
}

/**
 * Format oracle age for display.
 */
export function formatOracleAge(ageSeconds: number | null): string {
    if (ageSeconds === null) return 'Unknown';
    if (ageSeconds < 60) return `${ageSeconds}s`;
    if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
    return `${Math.floor(ageSeconds / 3600)}h`;
}
