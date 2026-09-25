import { calculateNetYield, sanitizeAssumptions } from "../services/netYieldEngine";

describe("netYieldEngine — extreme APY inputs", () => {
    it("handles zero gross APY", () => {
        const result = calculateNetYield(0);
        expect(result.grossApy).toBe(0);
        expect(result.netApy).toBe(0);
        expect(result.feeDragApy).toBe(0);
    });

    it("clamps extreme positive APY to 1000", () => {
        const result = calculateNetYield(99999);
        expect(result.grossApy).toBe(1000);
        expect(result.netApy).toBeGreaterThanOrEqual(0);
        expect(result.netApy).toBeLessThanOrEqual(1000);
    });

    it("clamps extreme negative APY to -100", () => {
        const result = calculateNetYield(-99999);
        expect(result.grossApy).toBe(-100);
    });

    it("handles NaN gross APY gracefully", () => {
        const result = calculateNetYield(NaN);
        expect(result.grossApy).toBe(0);
        expect(result.netApy).toBe(0);
    });

    it("handles Infinity gross APY gracefully", () => {
        const result = calculateNetYield(Infinity);
        expect(result.grossApy).toBe(0);
        expect(result.netApy).toBe(0);
    });

    it("handles negative Infinity gross APY gracefully", () => {
        const result = calculateNetYield(-Infinity);
        expect(result.grossApy).toBe(0);
    });

    it("produces sensible net APY for very small positive APY", () => {
        const result = calculateNetYield(0.001);
        expect(result.netApy).toBeGreaterThanOrEqual(0);
        expect(result.netApy).toBeLessThanOrEqual(0.001);
    });

    it("net APY never exceeds gross APY", () => {
        const cases = [0.01, 1, 5, 10, 50, 100, 500, 1000];
        for (const gross of cases) {
            const result = calculateNetYield(gross);
            expect(result.netApy).toBeLessThanOrEqual(result.grossApy);
        }
    });
});

describe("netYieldEngine — fee assumption boundaries", () => {
    it("zero fees produce net APY equal to gross APY", () => {
        const result = calculateNetYield(10, {
            protocolFeeBps: 0,
            vaultFeeBps: 0,
            rebalanceCostBps: 0,
            slippageBps: 0,
        });
        expect(result.netApy).toBe(10);
        expect(result.feeDragApy).toBe(0);
    });

    it("maximum fees produce net APY equal to zero or negative", () => {
        const result = calculateNetYield(10, {
            protocolFeeBps: 3000,
            vaultFeeBps: 3000,
            rebalanceCostBps: 3000,
            slippageBps: 3000,
        });
        expect(result.netApy).toBeLessThanOrEqual(0);
        expect(result.feeDragApy).toBeGreaterThan(0);
    });

    it("clamps individual fee assumptions above 3000 bps", () => {
        const sanitized = sanitizeAssumptions({
            protocolFeeBps: 5000,
            vaultFeeBps: 4000,
            rebalanceCostBps: 10000,
            slippageBps: 9999,
        });
        expect(sanitized.protocolFeeBps).toBe(3000);
        expect(sanitized.vaultFeeBps).toBe(3000);
        expect(sanitized.rebalanceCostBps).toBe(3000);
        expect(sanitized.slippageBps).toBe(3000);
    });

    it("clamps negative fee assumptions to zero", () => {
        const sanitized = sanitizeAssumptions({
            protocolFeeBps: -100,
            vaultFeeBps: -50,
            rebalanceCostBps: -25,
            slippageBps: -10,
        });
        expect(sanitized.protocolFeeBps).toBe(0);
        expect(sanitized.vaultFeeBps).toBe(0);
        expect(sanitized.rebalanceCostBps).toBe(0);
        expect(sanitized.slippageBps).toBe(0);
    });

    it("handles NaN fee assumptions", () => {
        const sanitized = sanitizeAssumptions({
            protocolFeeBps: NaN,
            vaultFeeBps: NaN,
            rebalanceCostBps: NaN,
            slippageBps: NaN,
        });
        expect(sanitized.protocolFeeBps).toBe(0);
        expect(sanitized.vaultFeeBps).toBe(0);
        expect(sanitized.rebalanceCostBps).toBe(0);
        expect(sanitized.slippageBps).toBe(0);
    });

    it("merges partial assumptions with defaults", () => {
        const sanitized = sanitizeAssumptions({ protocolFeeBps: 200 });
        expect(sanitized.protocolFeeBps).toBe(200);
        expect(sanitized.vaultFeeBps).toBe(80);
        expect(sanitized.rebalanceCostBps).toBe(25);
        expect(sanitized.slippageBps).toBe(30);
    });
});

describe("netYieldEngine — sensitivity output", () => {
    it("always returns low/medium/high environments", () => {
        const result = calculateNetYield(10);
        expect(result.sensitivity).toHaveLength(3);
        const envs = result.sensitivity.map((s) => s.environment);
        expect(envs).toContain("low");
        expect(envs).toContain("medium");
        expect(envs).toContain("high");
    });

    it("low sensitivity net APY is greater than high sensitivity net APY", () => {
        const result = calculateNetYield(20);
        const lowNet = result.sensitivity.find((s) => s.environment === "low")!.netApy;
        const highNet = result.sensitivity.find((s) => s.environment === "high")!.netApy;
        expect(lowNet).toBeGreaterThan(highNet);
    });

    it("sensitivity is empty for zero APY", () => {
        const result = calculateNetYield(0);
        expect(result.sensitivity.every((s) => s.netApy === 0)).toBe(true);
    });
});

describe("netYieldEngine — fee attribution", () => {
    it("fee attribution totals match feeDragApy", () => {
        const result = calculateNetYield(15, {
            protocolFeeBps: 100,
            vaultFeeBps: 80,
            rebalanceCostBps: 25,
            slippageBps: 30,
        });
        const attribution = result.feeAttribution;
        expect(attribution.totalFeeDragApy).toBeCloseTo(result.feeDragApy, 1);
    });

    it("each fee component is non-negative", () => {
        const result = calculateNetYield(10);
        expect(result.feeAttribution.managementFeeApy).toBeGreaterThanOrEqual(0);
        expect(result.feeAttribution.protocolFeeApy).toBeGreaterThanOrEqual(0);
        expect(result.feeAttribution.slippageApy).toBeGreaterThanOrEqual(0);
        expect(result.feeAttribution.networkFeeApy).toBeGreaterThanOrEqual(0);
        expect(result.feeAttribution.rewardOffsetApy).toBeGreaterThanOrEqual(0);
    });

    it("unknown fee is zero when all fees are explicitly accounted", () => {
        const result = calculateNetYield(10, {
            protocolFeeBps: 100,
            vaultFeeBps: 50,
            rebalanceCostBps: 25,
            slippageBps: 25,
        });
        expect(result.feeAttribution.unknownFeeApy).toBe(0);
    });
});
