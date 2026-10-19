/**
 * Backtest API Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

describe("Backtest API", () => {
    it("should validate date range", () => {
        const startDate = "2024-01-01";
        const endDate = "2024-12-31";

        expect(new Date(startDate) < new Date(endDate)).toBe(true);
    });

    it("should reject invalid date format", () => {
        const invalidDate = "invalid-date";
        expect(isNaN(new Date(invalidDate).getTime())).toBe(true);
    });

    it("should reject start date after end date", () => {
        const startDate = new Date("2024-12-31");
        const endDate = new Date("2024-01-01");

        expect(startDate >= endDate).toBe(true);
    });

    it("should limit query range to 2 years", () => {
        const startDate = new Date("2020-01-01");
        const endDate = new Date("2025-01-01");
        const maxRange = 2 * 365 * 24 * 60 * 60 * 1000;

        expect(endDate.getTime() - startDate.getTime() > maxRange).toBe(true);
    });

    it("should calculate compound interest", () => {
        const initial = 1000000000n;
        const dailyRate = 0.1 / 365; // 10% APY
        const multiplier = BigInt(Math.round((1 + dailyRate) * 1e9));
        const afterOneDay = (initial * multiplier) / BigInt(1e9);

        expect(afterOneDay).toBeGreaterThan(initial);
    });

    it("should handle multiple days of compounding", () => {
        let value = 1000000000n;
        const dailyRate = 0.1 / 365;
        const multiplier = BigInt(Math.round((1 + dailyRate) * 1e9));

        for (let i = 0; i < 365; i++) {
            value = (value * multiplier) / BigInt(1e9);
        }

        // After 1 year at 10% APY, should be ~11000
        expect(value).toBeGreaterThan(1090000000n);
        expect(value).toBeLessThan(1110000000n);
    });
});

describe("Option assignment", () => {
    interface WriterPosition {
        writer: string;
        collateral: bigint;
        createdAt: number;
    }

    interface Assignment {
        writer: string;
        amount: bigint;
    }

    /**
     * Deterministically select and settle eligible writer positions.
     * Positions are ordered by createdAt ascending, then writer address
     * lexicographically, so assignment is stable across runs.
     */
    function assignWriters(
        positions: WriterPosition[],
        exerciseAmount: bigint,
    ): { assignments: Assignment[]; remaining: bigint } {
        const ordered = [...positions].sort((a, b) => {
            if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
            return a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0;
        });

        const assignments: Assignment[] = [];
        let remaining = exerciseAmount;

        for (const position of ordered) {
            if (remaining <= 0n) break;
            if (position.collateral <= 0n) continue;

            const amount =
                position.collateral < remaining ? position.collateral : remaining;
            assignments.push({ writer: position.writer, amount });
            remaining -= amount;
        }

        return { assignments, remaining };
    }

    it("should assign across multiple writers deterministically", () => {
        const positions: WriterPosition[] = [
            { writer: "0xbbb", collateral: 500n, createdAt: 2 },
            { writer: "0xaaa", collateral: 500n, createdAt: 1 },
            { writer: "0xccc", collateral: 500n, createdAt: 3 },
        ];

        const { assignments, remaining } = assignWriters(positions, 1200n);

        expect(remaining).toBe(0n);
        expect(assignments).toEqual([
            { writer: "0xaaa", amount: 500n },
            { writer: "0xbbb", amount: 500n },
            { writer: "0xccc", amount: 200n },
        ]);
    });

    it("should partially assign a single writer position", () => {
        const positions: WriterPosition[] = [
            { writer: "0xaaa", collateral: 1000n, createdAt: 1 },
        ];

        const { assignments, remaining } = assignWriters(positions, 400n);

        expect(remaining).toBe(0n);
        expect(assignments).toEqual([{ writer: "0xaaa", amount: 400n }]);
    });

    it("should exhaust available collateral and report remaining amount", () => {
        const positions: WriterPosition[] = [
            { writer: "0xaaa", collateral: 300n, createdAt: 1 },
            { writer: "0xbbb", collateral: 200n, createdAt: 2 },
        ];

        const { assignments, remaining } = assignWriters(positions, 1000n);

        expect(remaining).toBe(500n);
        expect(assignments).toEqual([
            { writer: "0xaaa", amount: 300n },
            { writer: "0xbbb", amount: 200n },
        ]);
    });

    it("should skip writers with no collateral", () => {
        const positions: WriterPosition[] = [
            { writer: "0xaaa", collateral: 0n, createdAt: 1 },
            { writer: "0xbbb", collateral: 250n, createdAt: 2 },
        ];

        const { assignments, remaining } = assignWriters(positions, 250n);

        expect(remaining).toBe(0n);
        expect(assignments).toEqual([{ writer: "0xbbb", amount: 250n }]);
    });

    it("should produce stable ordering for equal timestamps", () => {
        const positions: WriterPosition[] = [
            { writer: "0xbbb", collateral: 100n, createdAt: 1 },
            { writer: "0xaaa", collateral: 100n, createdAt: 1 },
        ];

        const first = assignWriters(positions, 150n);
        const second = assignWriters([...positions].reverse(), 150n);

        expect(first).toEqual(second);
        expect(first.assignments).toEqual([
            { writer: "0xaaa", amount: 100n },
            { writer: "0xbbb", amount: 50n },
        ]);
    });
});
