/**
 * vestingService.test.ts
 *
 * Unit tests for the vesting helper utilities.
 * Target: ≥ 90 % coverage on `formatTokens`, `vestedPercent`, `claimedPercent`.
 *
 * Note: `fetchVestingSchedule` and `claimVested` perform live Soroban RPC calls
 * and Freighter wallet interactions — they are covered by integration tests.
 * The smoke tests below confirm their early-return (no-config) behaviour.
 */
import { describe, it, expect } from "vitest";
import {
    formatTokens,
    vestedPercent,
    claimedPercent,
    fetchVestingSchedule,
    claimVested,
    type VestingSchedule,
} from "./vestingService";

// ── formatTokens ─────────────────────────────────────────────────────────

describe("formatTokens", () => {
    it("formats zero", () => {
        expect(formatTokens(0n)).toBe("0 YIELD");
    });

    it("formats whole numbers (no fractional part)", () => {
        expect(formatTokens(10_000_000n)).toBe("1 YIELD");
        expect(formatTokens(100_000_000n)).toBe("10 YIELD");
    });

    it("formats fractional amounts", () => {
        expect(formatTokens(5_000_000n)).toBe("0.5 YIELD");
        expect(formatTokens(1n)).toBe("0.0000001 YIELD");
    });

    it("trims trailing zeroes in fractional part", () => {
        expect(formatTokens(1_500_000n)).toBe("0.15 YIELD");
    });

    it("accepts a custom symbol", () => {
        expect(formatTokens(10_000_000n, "XLM")).toBe("1 XLM");
    });

    it("handles large values", () => {
        expect(formatTokens(1_000_000_000_000_000n)).toBe("100000000 YIELD");
    });
});

// ── Shared schedule factory ───────────────────────────────────────────────

function makeSchedule(
    total: bigint,
    vested: bigint,
    claimed: bigint,
): VestingSchedule {
    return {
        totalAllocation: total,
        vestedAmount: vested,
        claimedAmount: claimed,
        claimableAmount: vested > claimed ? vested - claimed : 0n,
        cliffTimestamp: 0,
        endTimestamp: 0,
        nextUnlockTimestamp: 0,
        startTimestamp: 0,
    };
}

// ── vestedPercent ─────────────────────────────────────────────────────────

describe("vestedPercent", () => {
    it("returns 0 when nothing has vested", () => {
        expect(vestedPercent(makeSchedule(100n, 0n, 0n))).toBe(0);
    });

    it("returns 50 when half has vested", () => {
        expect(vestedPercent(makeSchedule(100n, 50n, 0n))).toBe(50);
    });

    it("returns 100 when fully vested", () => {
        expect(vestedPercent(makeSchedule(100n, 100n, 0n))).toBe(100);
    });

    it("returns 0 when total allocation is 0", () => {
        expect(vestedPercent(makeSchedule(0n, 0n, 0n))).toBe(0);
    });

    it("uses integer division of bigints", () => {
        // 1 / 3 → floors to 33
        expect(vestedPercent(makeSchedule(300n, 100n, 0n))).toBe(33);
    });
});

// ── claimedPercent ────────────────────────────────────────────────────────

describe("claimedPercent", () => {
    it("returns 0 when nothing claimed", () => {
        expect(claimedPercent(makeSchedule(100n, 50n, 0n))).toBe(0);
    });

    it("returns correct value when partially claimed", () => {
        expect(claimedPercent(makeSchedule(100n, 50n, 25n))).toBe(25);
    });

    it("returns 100 when all claimed", () => {
        expect(claimedPercent(makeSchedule(100n, 100n, 100n))).toBe(100);
    });

    it("returns 0 when total allocation is 0", () => {
        expect(claimedPercent(makeSchedule(0n, 0n, 0n))).toBe(0);
    });
});

// ── Async smoke tests (no contract ID configured) ─────────────────────────
//
// VITE_VESTING_CONTRACT_ID is not set in the test environment, so both
// async functions return immediately from their early-return guard.
// These tests verify that the guards behave correctly and do not throw.

describe("fetchVestingSchedule (no contract configured)", () => {
    it("returns null without throwing when no contract ID is set", async () => {
        const result = await fetchVestingSchedule("GADDRTEST0000000000000000000000000000000");
        expect(result).toBeNull();
    });

    it("returns null for an empty wallet address", async () => {
        const result = await fetchVestingSchedule("");
        expect(result).toBeNull();
    });
});

describe("claimVested (no contract configured)", () => {
    it("returns a failure result without throwing when no contract ID is set", async () => {
        const result = await claimVested("GADDRTEST0000000000000000000000000000000");
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it("error message mentions the contract is not configured", async () => {
        const result = await claimVested("GADDRTEST0000000000000000000000000000000");
        expect(result.error).toMatch(/not configured/i);
    });
});
