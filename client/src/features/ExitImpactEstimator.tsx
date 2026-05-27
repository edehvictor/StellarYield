import React, { useMemo } from "react";
import { AlertTriangle, Info, TrendingDown, TrendingUp } from "lucide-react";

interface ExitImpactEstimatorProps {
  amountUsd: number;
  poolLiquidityUsd: number;
  exitFeeBps: number;
}

export const ExitImpactEstimator: React.FC<ExitImpactEstimatorProps> = ({
  amountUsd,
  poolLiquidityUsd,
  exitFeeBps,
}) => {
  const estimate = useMemo(() => {
    const priceImpact = amountUsd / (poolLiquidityUsd + amountUsd);
    const feeDrag = (amountUsd * exitFeeBps) / 10000;
    const baseReceived = amountUsd - feeDrag;
    const actualReceived = baseReceived * (1 - priceImpact);

    return {
      received: actualReceived,
      impact: priceImpact * 100,
      fee: feeDrag,
      optimistic: baseReceived * (1 - priceImpact * 0.5),
      conservative: baseReceived * (1 - priceImpact * 1.5),
    };
  }, [amountUsd, poolLiquidityUsd, exitFeeBps]);

  if (amountUsd <= 0) return null;

  return (
    <div className="glass-panel p-6 space-y-4 border border-white/10">
      <h3 className="text-lg font-bold flex items-center gap-2">
        <Info size={20} className="text-[#6C5DD3]" />
        Exit Impact Estimate
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <p className="text-sm text-gray-400">Estimated Received</p>
          <p className="text-2xl font-bold">${estimate.received.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-gray-400">Price Impact</p>
          <p className={`text-2xl font-bold ${estimate.impact > 2 ? "text-red-500" : "text-[#3EAC75]"}`}>
            {estimate.impact.toFixed(2)}%
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 p-3 bg-black/20 rounded-lg">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400 flex items-center gap-1">
            <TrendingUp size={14} className="text-[#3EAC75]" /> Optimistic Case
          </span>
          <span className="font-medium">${estimate.optimistic.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400 flex items-center gap-1">
            <TrendingDown size={14} className="text-red-500" /> Conservative Case
          </span>
          <span className="font-medium">${estimate.conservative.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
      </div>

      {estimate.impact > 1 && (
        <div className="flex items-start gap-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <p className="text-xs text-yellow-200/80">
            High price impact detected. Large withdrawals relative to pool depth can significantly reduce the amount you receive. 
            Consider withdrawing in smaller batches or during periods of higher liquidity.
          </p>
        </div>
      )}
    </div>
  );
};
