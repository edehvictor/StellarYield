import React from "react";
import { PieChart, TrendingUp, Zap, RotateCcw, Target } from "lucide-react";

interface Attribution {
    baseYield: number;
    incentives: number;
    compounding: number;
    tacticalRotation: number;
}

interface ApyAttributionProps {
    attribution: Attribution;
    totalApy: number;
}

const ApyAttribution: React.FC<ApyAttributionProps> = ({ attribution, totalApy }) => {
    const sources = [
        { label: "Base Yield", value: attribution.baseYield, icon: TrendingUp, color: "bg-blue-500" },
        { label: "Incentives", value: attribution.incentives, icon: Zap, color: "bg-purple-500" },
        { label: "Compounding", value: attribution.compounding, icon: RotateCcw, color: "bg-green-500" },
        { label: "Tactical Rotation", value: attribution.tacticalRotation, icon: Target, color: "bg-orange-500" },
    ];

    return (
        <div className="glass-panel p-4 rounded-2xl border-white/5 space-y-4">
            <div className="flex items-center gap-2 mb-2">
                <PieChart size={18} className="text-indigo-400" />
                <h3 className="text-sm font-bold tracking-wide uppercase text-gray-400">APY Attribution</h3>
            </div>

            <div className="space-y-3">
                {sources.map((source) => {
                    const percentage = (source.value / totalApy) * 100;
                    return (
                        <div key={source.label} className="space-y-1">
                            <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-gray-500">
                                <div className="flex items-center gap-1.5">
                                    <source.icon size={12} className="text-gray-400" />
                                    {source.label}
                                </div>
                                <span>{source.value.toFixed(2)}%</span>
                            </div>
                            <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                                <div
                                    className={`h-full ${source.color} transition-all duration-1000 ease-out`}
                                    style={{ width: `${percentage}%` }}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="pt-2 border-t border-white/5 flex justify-between items-center">
                <span className="text-[10px] font-bold text-gray-500 uppercase">Total Verified APY</span>
                <span className="text-lg font-black text-white">{totalApy.toFixed(2)}%</span>
            </div>
        </div>
    );
};

export default ApyAttribution;
