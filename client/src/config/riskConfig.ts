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
    return RISK_EXPIANATIONS[level].explanation;
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
        badge: '◎ No Data',
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

/**
 * Treasury exposure limits by asset class.
 *
 * The dashboard warns when a treasury holds more than the configured
 * share of value in a single asset class. Thresholds are expressed as a
 * percentage of total treasury value (0 - 100).
 */

export type AssetClass = 'stablecoin' | 'blue_chip' | 'volatile' | 'lp_token' | 'other';

export type ExposureSeverity = 'ok' | 'warning' | 'critical';

export interface AssetClassLimit {
    /** Human readable label for the asset class. */
    label: string;
    /** Maximum allowed share of total treasury value (0 - 100). */
    maxSharePct: number;
    /** Share at which the dashboard starts warning (0 - 100). */
    warnSharePct: number;
    /** Explanation shown in tooltips and warnings. */
    explanation: string;
}

export const ASSET_CLASS_LIMITS: Record<AssetClass, AssetClassLimit> = {
    stablecoin: {
        label: 'Stablecoin',
        maxSharePct: 70,
        warnSharePct: 50,
        explanation: 'Stablecoins are low risk but concentration creates issuer and de-peg exposure.',
    },
    blue_chip: {
        label: 'Blue-chip',
        maxSharePct: 50,
        warnSharePct: 35,
        explanation: 'Large-cap assets are liquid but still carry market risk.',
    },
    volatile: {
        label: 'Volatile',
        maxSharePct: 25,
        warnSharePct: 15,
        explanation: 'Volatile assets can drawdown sharply; keep exposure limited.',
    },
    lp_token: {
        label: 'LP Token',
        maxSharePct: 30,
        warnSharePct: 20,
        explanation: 'LP tokens carry impermanent loss and smart contract risk.',
    },
    other: {
        label: 'Other',
        maxSharePct: 10,
        warnSharePct: 5,
        explanation: 'Unclassified assets have unknown risk profiles.',
    },
};

export interface AssetExposureInput {
    assetClass: AssetClass;
    /** Value of this asset class in the treasury (non-negative). */
    valueUsd: number;
}

export interface AssetExposureResult {
    assetClass: AssetClass;
    label: string;
    valueUsd: number;
    /** Share of total treasury value (0 - 100). 0 when total value is 0. */
    sharePct: number;
    maxSharePct: number;
    warnSharePct: number;
    severity: ExposureSeverity;
    /** Stable message suitable for display, or null when ok. */
    message: string | null;
}

export interface TreasuryExposureResult {
    totalValueUsd: number;
    exposures: AssetExposureResult[];
    warnings: AssetExposureResult[];
    /** True when any asset class is at or above its maximum share. */
    hasCritical: boolean;
    /** True when any asset class is at or above its warn share. */
    hasWarning: boolean;
}

export type TreasuryExposureErrorCode = 'invalid_input';

export interface TreasuryExposureError {
    code: TreasuryExposureErrorCode;
    message: string;
}

export class TreasuryExposureValidationError extends Error {
    readonly code: TreasuryExposureErrorCode = 'invalid_input';

    constructor(message: string) {
        super(message);
        this.name = 'TreasuryExposureValidationError';
    }

    toJSON(): TreasuryExposureError {
        return { code: this.code, message: this.message };
    }
}

function roundToTwoDecimals(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Evaluate treasury exposure by asset class against configured limits.
 *
 * Throws a TreasuryExposureValidationError with a stable code and
 * message for invalid inputs (negative or non-finite values, unknown
 * asset classes). Empty inputs return a zero-total result with no warnings.
 */
export function evaluateTreasuryExposure(
    inputs: readonly AssetExposureInput[]
): TreasuryExposureResult {
    if (!Array.isArray(inputs)) {
        throw new TreasuryExposureValidationError('Exposure inputs must be an array.');
    }

    const totalValueUsd = inputs.reduce((sum, item) => {
        if (!item || typeof item !== 'object') {
            throw new TreasuryExposureValidationError('Each exposure entry must be an object.');
        }
        if (!(item.assetClass in ASSET_CLASS_LIMITS)) {
            throw new TreasuryExposureValidationError(
                `Unknown asset class: ${String(item.assetClass)}.`
            );
        }
        if (typeof item.valueUsd !== 'number' || !Number.isFinite(item.valueUsd)) {
            throw new TreasuryExposureValidationError('Exposure values must be finite numbers.');
        }
        if (item.valueUsd < 0) {
            throw new TreasuryExposureValidationError('Exposure values must not be negative.');
        }
        return sum + item.valueUsd;
    }, 0);

    const exposures: AssetExposureResult[] = inputs.map((item) => {
        const config = ASSET_CLASS_LIMITS[item.assetClass];
        const sharePct = totalValueUsd > 0 ? (item.valueUsd / totalValueUsd) * 100 : 0;
        const roundedShare = roundToTwoDecimals(sharePct);

        let severity: ExposureSeverity = 'ok';
        let message: string | null = null;

        if (roundedShare >= config.maxSharePct) {
            severity = 'critical';
            message = `${config.label} exposure at ${roundedShare.toFixed(2)}% exceeds the ${config.maxSharePct}% limit. Reduce exposure before adding more.`;
        } else if (roundedShare >= config.warnSharePct) {
            severity = 'warning';
            message = `${config.label} exposure at ${roundedShare.toFixed(2)}% is approaching the ${config.maxSharePct}% limit.`;
        }

        return {
            assetClass: item.assetClass,
            label: config.label,
            valueUsd: item.valueUsd,
            sharePct: roundedShare,
            maxSharePct: config.maxSharePct,
            warnSharePct: config.warnSharePct,
            severity,
            message,
        };
    });

    const warnings = exposures.filter((e) => e.severity !== 'ok');

    return {
        totalValueUsd: roundToTwoDecimals(totalValueUsd),
        exposures,
        warnings,
        hasCritical: exposures.some((e) => e.severity === 'critical'),
        hasWarning: exposures.some((e) => e.severity === 'warning'),
    };
}

export function getAssetClassLimit(assetClass: AssetClass): AssetClassLimit {
    return ASSET_CLASS_LIMITS[assetClass];
}
