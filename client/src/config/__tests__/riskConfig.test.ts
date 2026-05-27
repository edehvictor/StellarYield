import { describe, it, expect } from 'vitest';
import {
    RISK_EXPLANATIONS,
    getRiskConfig,
    getRiskExplanation,
    type RiskLevel,
} from '../riskConfig';

describe('riskConfig', () => {
    describe('RISK_EXPLANATIONS', () => {
        it('contains all three risk levels', () => {
            expect(RISK_EXPLANATIONS).toHaveProperty('Low');
            expect(RISK_EXPLANATIONS).toHaveProperty('Medium');
            expect(RISK_EXPLANATIONS).toHaveProperty('High');
        });

        it('each risk level has required properties', () => {
            const requiredProps = ['color', 'bg', 'border', 'order', 'explanation'];
            Object.values(RISK_EXPLANATIONS).forEach((config) => {
                requiredProps.forEach((prop) => {
                    expect(config).toHaveProperty(prop);
                });
            });
        });

        it('has unique order values', () => {
            const orders = Object.values(RISK_EXPLANATIONS).map((c) => c.order);
            const uniqueOrders = new Set(orders);
            expect(uniqueOrders.size).toBe(orders.length);
        });

        it('has consistent color classes', () => {
            Object.values(RISK_EXPLANATIONS).forEach((config) => {
                expect(config.color).toMatch(/^text-/);
                expect(config.bg).toMatch(/^bg-/);
                expect(config.border).toMatch(/^border-/);
            });
        });

        it('has non-empty explanations', () => {
            Object.values(RISK_EXPLANATIONS).forEach((config) => {
                expect(config.explanation.length).toBeGreaterThan(0);
            });
        });
    });

    describe('getRiskConfig', () => {
        it('returns config for Low risk', () => {
            const config = getRiskConfig('Low');
            expect(config).toBe(RISK_EXPLANATIONS.Low);
            expect(config.explanation).toBe('High TVL, battle-tested protocol, highly liquid.');
        });

        it('returns config for Medium risk', () => {
            const config = getRiskConfig('Medium');
            expect(config).toBe(RISK_EXPLANATIONS.Medium);
            expect(config.explanation).toBe('Moderate volatility or newer protocol with steady growth.');
        });

        it('returns config for High risk', () => {
            const config = getRiskConfig('High');
            expect(config).toBe(RISK_EXPLANATIONS.High);
            expect(config.explanation).toBe('Low TVL, highly volatile assets, or experimental protocol.');
        });
    });

    describe('getRiskExplanation', () => {
        it('returns explanation for Low risk', () => {
            const explanation = getRiskExplanation('Low');
            expect(explanation).toBe('High TVL, battle-tested protocol, highly liquid.');
        });

        it('returns explanation for Medium risk', () => {
            const explanation = getRiskExplanation('Medium');
            expect(explanation).toBe('Moderate volatility or newer protocol with steady growth.');
        });

        it('returns explanation for High risk', () => {
            const explanation = getRiskExplanation('High');
            expect(explanation).toBe('Low TVL, highly volatile assets, or experimental protocol.');
        });

        it('returns consistent explanations across calls', () => {
            const levels: RiskLevel[] = ['Low', 'Medium', 'High'];
            levels.forEach((level) => {
                const exp1 = getRiskExplanation(level);
                const exp2 = getRiskExplanation(level);
                expect(exp1).toBe(exp2);
            });
        });
    });

    describe('consistency across components', () => {
        it('Low risk has green styling', () => {
            const config = getRiskConfig('Low');
            expect(config.color).toContain('green');
            expect(config.bg).toContain('green');
            expect(config.border).toContain('green');
        });

        it('Medium risk has yellow styling', () => {
            const config = getRiskConfig('Medium');
            expect(config.color).toContain('yellow');
            expect(config.bg).toContain('yellow');
            expect(config.border).toContain('yellow');
        });

        it('High risk has red styling', () => {
            const config = getRiskConfig('High');
            expect(config.color).toContain('red');
            expect(config.bg).toContain('red');
            expect(config.border).toContain('red');
        });
    });
});
