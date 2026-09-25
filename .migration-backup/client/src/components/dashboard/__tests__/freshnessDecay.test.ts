import { describe, it, expect } from 'vitest';
import {
    computeDecayedFreshnessConfidence,
    DEFAULT_UI_FRESHNESS_POLICY,
    FreshnessPolicy,
} from '../freshnessDecay';

describe('computeDecayedFreshnessConfidence', () => {
    describe('boundary conditions - fresh window', () => {
        it('returns full confidence (1) at age 0', () => {
            const result = computeDecayedFreshnessConfidence(0);
            expect(result.confidence).toBe(1);
            expect(result.unusable).toBe(false);
        });

        it('returns full confidence at exactly fresh window boundary', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.freshWindowMs
            );
            expect(result.confidence).toBe(1);
            expect(result.unusable).toBe(false);
        });

        it('returns full confidence just before fresh window expires', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.freshWindowMs - 1
            );
            expect(result.confidence).toBe(1);
            expect(result.unusable).toBe(false);
        });

        it('starts decay just after fresh window', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.freshWindowMs + 1
            );
            expect(result.confidence).toBeLessThan(1);
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.unusable).toBe(false);
        });
    });

    describe('boundary conditions - soft stale threshold', () => {
        it('returns reduced confidence at exactly soft stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.softStaleMs
            );
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThan(1);
            expect(result.unusable).toBe(false);
        });

        it('returns reduced confidence just before soft stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.softStaleMs - 1
            );
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThan(1);
            expect(result.unusable).toBe(false);
        });

        it('returns reduced confidence just after soft stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.softStaleMs + 1
            );
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThan(1);
            expect(result.unusable).toBe(false);
        });
    });

    describe('boundary conditions - hard stale threshold', () => {
        it('returns zero confidence at exactly hard stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.hardStaleMs
            );
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });

        it('returns zero confidence just before hard stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.hardStaleMs - 1
            );
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThan(1);
            expect(result.unusable).toBe(false);
        });

        it('returns zero confidence just after hard stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.hardStaleMs + 1
            );
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });

        it('returns zero confidence far beyond hard stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                DEFAULT_UI_FRESHNESS_POLICY.hardStaleMs * 10
            );
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });
    });

    describe('invalid ages', () => {
        it('handles negative age gracefully', () => {
            const result = computeDecayedFreshnessConfidence(-1000);
            expect(result.confidence).toBe(1);
            expect(result.unusable).toBe(false);
        });

        it('handles zero age', () => {
            const result = computeDecayedFreshnessConfidence(0);
            expect(result.confidence).toBe(1);
            expect(result.unusable).toBe(false);
        });

        it('handles very large ages', () => {
            const result = computeDecayedFreshnessConfidence(Number.MAX_SAFE_INTEGER);
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });
    });

    describe('linear decay curve', () => {
        const linearPolicy: FreshnessPolicy = {
            curve: 'linear',
            freshWindowMs: 60_000,
            softStaleMs: 10 * 60_000,
            hardStaleMs: 45 * 60_000,
        };

        it('decays linearly from fresh to soft stale', () => {
            const fresh = computeDecayedFreshnessConfidence(
                linearPolicy.freshWindowMs,
                linearPolicy
            );
            const midpoint = computeDecayedFreshnessConfidence(
                (linearPolicy.freshWindowMs + linearPolicy.softStaleMs) / 2,
                linearPolicy
            );
            const justBeforeSoftStale = computeDecayedFreshnessConfidence(
                linearPolicy.softStaleMs - 1,
                linearPolicy
            );

            expect(fresh.confidence).toBe(1);
            expect(midpoint.confidence).toBeCloseTo(0.5, 1);
            expect(justBeforeSoftStale.confidence).toBeGreaterThan(0);
            expect(justBeforeSoftStale.confidence).toBeLessThan(1);
        });

        it('reaches zero at hard stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                linearPolicy.hardStaleMs,
                linearPolicy
            );
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });
    });

    describe('exponential decay curve', () => {
        const exponentialPolicy: FreshnessPolicy = {
            curve: 'exponential',
            freshWindowMs: 60_000,
            softStaleMs: 10 * 60_000,
            hardStaleMs: 45 * 60_000,
            decayK: 3.5,
        };

        it('decays exponentially with steeper initial drop', () => {
            const fresh = computeDecayedFreshnessConfidence(
                exponentialPolicy.freshWindowMs,
                exponentialPolicy
            );
            const quarter = computeDecayedFreshnessConfidence(
                exponentialPolicy.freshWindowMs +
                (exponentialPolicy.softStaleMs - exponentialPolicy.freshWindowMs) * 0.25,
                exponentialPolicy
            );
            const threeQuarters = computeDecayedFreshnessConfidence(
                exponentialPolicy.freshWindowMs +
                (exponentialPolicy.softStaleMs - exponentialPolicy.freshWindowMs) * 0.75,
                exponentialPolicy
            );

            expect(fresh.confidence).toBe(1);
            expect(quarter.confidence).toBeGreaterThan(threeQuarters.confidence);
        });

        it('respects custom decay constant', () => {
            const fastDecay: FreshnessPolicy = {
                ...exponentialPolicy,
                decayK: 10,
            };
            const slowDecay: FreshnessPolicy = {
                ...exponentialPolicy,
                decayK: 1,
            };

            const midpoint = (exponentialPolicy.freshWindowMs + exponentialPolicy.softStaleMs) / 2;
            const fast = computeDecayedFreshnessConfidence(midpoint, fastDecay);
            const slow = computeDecayedFreshnessConfidence(midpoint, slowDecay);

            expect(fast.confidence).toBeLessThan(slow.confidence);
        });

        it('reaches zero at hard stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                exponentialPolicy.hardStaleMs,
                exponentialPolicy
            );
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });
    });

    describe('stepwise decay curve', () => {
        const stepwisePolicy: FreshnessPolicy = {
            curve: 'stepwise',
            freshWindowMs: 60_000,
            softStaleMs: 10 * 60_000,
            hardStaleMs: 45 * 60_000,
        };

        it('returns 0.85 confidence in first third', () => {
            const age =
                stepwisePolicy.freshWindowMs +
                (stepwisePolicy.softStaleMs - stepwisePolicy.freshWindowMs) * 0.15;
            const result = computeDecayedFreshnessConfidence(age, stepwisePolicy);
            expect(result.confidence).toBe(0.85);
            expect(result.unusable).toBe(false);
        });

        it('returns 0.55 confidence in second third', () => {
            const age =
                stepwisePolicy.freshWindowMs +
                (stepwisePolicy.softStaleMs - stepwisePolicy.freshWindowMs) * 0.5;
            const result = computeDecayedFreshnessConfidence(age, stepwisePolicy);
            expect(result.confidence).toBe(0.55);
            expect(result.unusable).toBe(false);
        });

        it('returns 0.25 confidence in final third', () => {
            const age =
                stepwisePolicy.freshWindowMs +
                (stepwisePolicy.softStaleMs - stepwisePolicy.freshWindowMs) * 0.85;
            const result = computeDecayedFreshnessConfidence(age, stepwisePolicy);
            expect(result.confidence).toBe(0.25);
            expect(result.unusable).toBe(false);
        });

        it('reaches zero at hard stale threshold', () => {
            const result = computeDecayedFreshnessConfidence(
                stepwisePolicy.hardStaleMs,
                stepwisePolicy
            );
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });
    });

    describe('confidence bounds', () => {
        it('always returns confidence between 0 and 1', () => {
            const testAges = [
                -1000,
                0,
                1000,
                DEFAULT_UI_FRESHNESS_POLICY.freshWindowMs,
                DEFAULT_UI_FRESHNESS_POLICY.softStaleMs,
                DEFAULT_UI_FRESHNESS_POLICY.hardStaleMs,
                DEFAULT_UI_FRESHNESS_POLICY.hardStaleMs * 2,
            ];

            testAges.forEach((age) => {
                const result = computeDecayedFreshnessConfidence(age);
                expect(result.confidence).toBeGreaterThanOrEqual(0);
                expect(result.confidence).toBeLessThanOrEqual(1);
            });
        });

        it('never returns NaN or Infinity', () => {
            const testAges = [
                -Infinity,
                -1000,
                0,
                1000,
                Number.MAX_SAFE_INTEGER,
                Infinity,
            ];

            testAges.forEach((age) => {
                const result = computeDecayedFreshnessConfidence(age);
                expect(Number.isFinite(result.confidence)).toBe(true);
                expect(Number.isNaN(result.confidence)).toBe(false);
            });
        });
    });

    describe('expected confidence behavior documentation', () => {
        it('fresh data (age < freshWindowMs) has full confidence', () => {
            // Data within the fresh window should always be fully trusted
            const result = computeDecayedFreshnessConfidence(30_000);
            expect(result.confidence).toBe(1);
            expect(result.unusable).toBe(false);
        });

        it('soft stale data (freshWindowMs <= age < hardStaleMs) has reduced confidence', () => {
            // Data between soft and hard stale thresholds should show reduced confidence
            // but still be usable with a warning
            const result = computeDecayedFreshnessConfidence(15 * 60_000);
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThan(1);
            expect(result.unusable).toBe(false);
        });

        it('hard stale data (age >= hardStaleMs) is marked unusable', () => {
            // Data beyond the hard stale threshold should be marked as unusable
            const result = computeDecayedFreshnessConfidence(50 * 60_000);
            expect(result.confidence).toBe(0);
            expect(result.unusable).toBe(true);
        });
    });
});
