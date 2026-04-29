import React from "react";

export interface BufferGuidanceItem {
  strategyId: string;
  stressLevel: "low" | "medium" | "stressed";
  recommendedBufferPct: number;
  recommendedBufferUsd: number;
  rationale: string[];
}

interface LiquidityBufferPanelProps {
  recommendations: BufferGuidanceItem[];
}

export const LiquidityBufferPanel: React.FC<LiquidityBufferPanelProps> = ({ recommendations }) => {
  return (
    <div className="glass-panel p-6">
      <h3 className="text-lg font-bold mb-4">Adaptive Liquidity Buffer Guidance</h3>
      <div className="space-y-4">
        {recommendations.map((rec) => (
          <div key={rec.strategyId} className="rounded-lg border border-gray-700 p-4">
            <div className="flex justify-between">
              <span className="font-semibold">{rec.strategyId}</span>
              <span className="uppercase text-xs tracking-wide">{rec.stressLevel}</span>
            </div>
            <p className="mt-2 text-sm text-gray-300">
              Hold {(rec.recommendedBufferPct * 100).toFixed(1)}% (${rec.recommendedBufferUsd.toLocaleString()}) as reserve liquidity.
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};
