export interface SlippageModel {
    protocol: string;
    calculateSlippage(amountIn: bigint, currentTvl: bigint): number;
}

export class DefaultSlippageModel implements SlippageModel {
    protocol = "default";
    calculateSlippage(amountIn: bigint, currentTvl: bigint): number {
        // Basic slippage model: 0.1% + 0.1% per 1% of TVL
        const amountNum = Number(amountIn);
        const tvlNum = Number(currentTvl);
        if (tvlNum === 0) return 0.05; // 5% default for 0 TVL
        const impact = amountNum / tvlNum;
        return 0.001 + impact * 0.1;
    }
}

export class BlendSlippageModel implements SlippageModel {
    protocol = "Blend";
    calculateSlippage(amountIn: bigint, currentTvl: bigint): number {
        // Blend has higher liquidity depth but steep tails
        const impact = Number(amountIn) / Number(currentTvl);
        return 0.0005 + impact * impact * 0.5;
    }
}

export class SoroswapSlippageModel implements SlippageModel {
    protocol = "Soroswap";
    calculateSlippage(amountIn: bigint, currentTvl: bigint): number {
        // Standard CPMM slippage: x * y = k => slippage approx amountIn / (reserves + amountIn)
        const impact = Number(amountIn) / (Number(currentTvl) / 2); // Assuming half TVL is the specific asset
        return impact / (1 + impact);
    }
}

export class DeFindexSlippageModel implements SlippageModel {
    protocol = "DeFindex";
    calculateSlippage(): number {
        // DeFindex rebalances, fixed impact for small trades
        return 0.002; // Flat 0.2%
    }
}

export class SlippageRegistry {
    private models: Map<string, SlippageModel> = new Map();
    private defaultModel: SlippageModel = new DefaultSlippageModel();

    constructor() {
        this.register(new BlendSlippageModel());
        this.register(new SoroswapSlippageModel());
        this.register(new DeFindexSlippageModel());
    }

    register(model: SlippageModel) {
        this.models.set(model.protocol.toLowerCase(), model);
    }

    getModel(protocol: string): SlippageModel {
        return this.models.get(protocol.toLowerCase()) || this.defaultModel;
    }
}

export const slippageRegistry = new SlippageRegistry();
