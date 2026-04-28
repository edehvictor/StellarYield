import { useEffect, useState } from "react";
import { Bot, Info, History } from "lucide-react";
import { apiUrl } from "../lib/api";

interface RecommendationTimelineEntry {
  id: string;
  recommendation: string;
  rationale: string;
  targetVault: string;
  changedInputs: string[];
  timestamp: string;
}

export default function AIAdvisor() {
  const [timeline, setTimeline] = useState<RecommendationTimelineEntry[]>([]);

  useEffect(() => {
    fetch(apiUrl("/api/recommend/timeline?userId=anonymous"))
      .then((res) => (res.ok ? res.json() : Promise.resolve({ timeline: [] })))
      .then((data: { timeline?: RecommendationTimelineEntry[] }) => {
        setTimeline(data.timeline ?? []);
      })
      .catch(() => {
        setTimeline([]);
      });
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6">
      <div className="bg-[#6C5DD3]/20 p-6 rounded-full inline-block mb-4 shadow-lg shadow-[#6C5DD3]/20">
        <Bot size={64} className="text-[#6C5DD3]" />
      </div>
      <h2 className="text-4xl font-extrabold text-white">Claude AI Yield Advisor</h2>
      <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
        Our integrated AI agent automatically analyzes Stellar's DeFi landscape to locate the optimal risk-to-reward vaults for your portfolio.
      </p>
      
      <div className="glass-panel p-8 mt-12 max-w-3xl w-full text-left">
        <div className="h-40 border-2 border-dashed border-[#6C5DD3]/30 rounded-xl flex items-center justify-center text-gray-500 mb-6">
           Coming Soon: Interactive AI Chatbot Widget
        </div>
        
        {/* Risk Badge Integration Demo */}
        <div className="p-4 bg-white/5 border border-white/10 rounded-xl">
          <h3 className="text-sm font-semibold text-white mb-3">AI Advisor Risk Assessment Example</h3>
          <p className="text-xs text-gray-400 mb-4">When recommending vaults, the AI will evaluate risk across multiple factors:</p>
          <div className="flex gap-4">
            <div
              className="group relative flex cursor-help outline-none"
              tabIndex={0}
              aria-describedby="ai-risk-tip-high"
            >
              <span className="bg-red-500/15 text-red-400 border-red-500/30 border px-2.5 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-1">
                High Risk <Info size={12} />
              </span>
              <div
                id="ai-risk-tip-high"
                role="tooltip"
                className="absolute hidden group-hover:block group-focus-within:block bottom-full mb-2 left-1/2 -translate-x-1/2 w-48 p-2 bg-[#1A1A24] border border-white/10 rounded-lg text-xs leading-relaxed text-gray-300 shadow-xl z-10 transition-opacity"
              >
                Low TVL, highly volatile assets, or experimental protocol.
              </div>
            </div>
            
            <div
              className="group relative flex cursor-help outline-none"
              tabIndex={0}
              aria-describedby="ai-risk-tip-low"
            >
              <span className="bg-green-500/15 text-green-400 border-green-500/30 border px-2.5 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-1">
                Low Risk <Info size={12} />
              </span>
              <div
                id="ai-risk-tip-low"
                role="tooltip"
                className="absolute hidden group-hover:block group-focus-within:block bottom-full mb-2 left-1/2 -translate-x-1/2 w-48 p-2 bg-[#1A1A24] border border-white/10 rounded-lg text-xs leading-relaxed text-gray-300 shadow-xl z-10 transition-opacity"
              >
                High TVL, battle-tested protocol, highly liquid.
              </div>
            </div>
          </div>
        </div>
        <div className="p-4 mt-5 bg-white/5 border border-white/10 rounded-xl">
          <div className="flex items-center gap-2 mb-3">
            <History size={16} className="text-[#6C5DD3]" />
            <h3 className="text-sm font-semibold text-white">Recommendation Timeline</h3>
          </div>
          {timeline.length === 0 ? (
            <p className="text-xs text-gray-400">
              No recommendation history yet. Run recommendations to inspect reasoning evolution.
            </p>
          ) : (
            <div className="space-y-3">
              {timeline.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <p className="text-sm text-white font-medium">{entry.targetVault}</p>
                  <p className="text-xs text-gray-400 mt-1">{entry.recommendation}</p>
                  <p className="text-xs text-gray-500 mt-1">{entry.rationale}</p>
                  <p className="text-[11px] text-[#6C5DD3] mt-2">
                    Changed inputs: {entry.changedInputs.join(", ")}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
