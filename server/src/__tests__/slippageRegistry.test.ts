// import { describe, it, expect } from "vitest";
import { slippageRegistry, BlendSlippageModel, SoroswapSlippageModel } from "../services/slippageRegistry";

describe("SlippageRegistry", () => {
    it("should return the correct model for registered protocols", () => {
        const blend = slippageRegistry.getModel("Blend");
        expect(blend.protocol).toBe("Blend");
        expect(blend).toBeInstanceOf(BlendSlippageModel);

        const soroswap = slippageRegistry.getModel("Soroswap");
        expect(soroswap.protocol).toBe("Soroswap");
        expect(soroswap).toBeInstanceOf(SoroswapSlippageModel);
    });

    it("should return the default model for unknown protocols", () => {
        const unknown = slippageRegistry.getModel("UnknownDeFi");
        expect(unknown.protocol).toBe("default");
    });

    it("should calculate slippage correctly for Blend", () => {
        const model = new BlendSlippageModel();
        const lowImpact = model.calculateSlippage(BigInt(100), BigInt(1000000));
        const highImpact = model.calculateSlippage(BigInt(500000), BigInt(1000000));

        expect(lowImpact).toBeLessThan(highImpact);
        expect(lowImpact).toBeCloseTo(0.0005, 5);
        expect(highImpact).toBeGreaterThan(0.1);
    });

    it("should calculate slippage correctly for Soroswap", () => {
        const model = new SoroswapSlippageModel();
        const impact = model.calculateSlippage(BigInt(5000), BigInt(100000));
        // impact = 5000 / (100000 / 2) = 5000 / 50000 = 0.1
        // slippage = 0.1 / (1 + 0.1) = 0.1 / 1.1 = 0.0909
        expect(impact).toBeCloseTo(0.0909, 4);
    });
});
