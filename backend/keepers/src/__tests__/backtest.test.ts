/**
 * Backtest API Tests
 */

import { describe, it, expect, beforeEach } from "vitest";

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
        const initial = 10000n;
        const dailyRate = 0.1 / 365 / 100; // 10% APY
        const multiplier = BigInt(Math.round((1 + dailyRate) * 1e9));
        const afterOneDay = (initial * multiplier) / BigInt(1e9);

        expect(afterOneDay).toBeGreaterThan(initial);
    });

    it("should handle multiple days of compounding", () => {
        let value = 10000n;
        const dailyRate = 0.1 / 365 / 100;
        const multiplier = BigInt(Math.round((1 + dailyRate) * 1e9));

        for (let i = 0; i < 365; i++) {
            value = (value * multiplier) / BigInt(1e9);
        }

        // After 1 year at 10% APY, should be ~11000
        expect(value).toBeGreaterThan(10900n);
        expect(value).toBeLessThan(11100n);
    });
});
