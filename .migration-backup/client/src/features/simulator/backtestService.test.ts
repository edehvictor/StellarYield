/**
 * Backtest Service Tests
 */

import { describe, it, expect } from "vitest";
import { calculateCompoundInterest, calculateTotalReturn } from "./backtestService";
import type { DailySnapshot } from "./types";

describe("Backtest Service", () => {
    it("should calculate compound interest correctly", () => {
        const initial = 10000n;
        const snapshots: DailySnapshot[] = [
            { date: "2024-01-01", apy: 10, equityValue: 0n },
            { date: "2024-01-02", apy: 10, equityValue: 0n },
            { date: "2024-01-03", apy: 10, equityValue: 0n },
        ];

        const result = calculateCompoundInterest(initial, snapshots);

        expect(result).toHaveLength(3);
        expect(result[0].equityValue).toBeGreaterThan(initial);
        expect(result[2].equityValue).toBeGreaterThan(result[1].equityValue);
    });

    it("should handle empty snapshots", () => {
        const initial = 10000n;
        const result = calculateCompoundInterest(initial, []);

        expect(result).toHaveLength(0);
    });

    it("should calculate total return correctly", () => {
        const initial = 10000n;
        const final = 11000n;

        const returnPct = calculateTotalReturn(initial, final);
        expect(returnPct).toBe(10);
    });

    it("should handle zero initial amount", () => {
        const returnPct = calculateTotalReturn(0n, 1000n);
        expect(returnPct).toBe(0);
    });

    it("should handle negative returns", () => {
        const initial = 10000n;
        const final = 9000n;

        const returnPct = calculateTotalReturn(initial, final);
        expect(returnPct).toBe(-10);
    });

    it("should preserve snapshot dates", () => {
        const initial = 10000n;
        const snapshots: DailySnapshot[] = [
            { date: "2024-01-01", apy: 10, equityValue: 0n },
            { date: "2024-01-02", apy: 10, equityValue: 0n },
        ];

        const result = calculateCompoundInterest(initial, snapshots);

        expect(result[0].date).toBe("2024-01-01");
        expect(result[1].date).toBe("2024-01-02");
    });
});
