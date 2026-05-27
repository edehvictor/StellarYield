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
