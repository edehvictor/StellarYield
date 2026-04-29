import React, { useState, useEffect } from "react";
import { AlertTriangle, ArrowRight, ShieldCheck } from "lucide-react";

export interface RecoveryRecommendation {
  path: "HOLD" | "UNWIND" | "ROTATE" | "REBALANCE";
  confidence: number;
  reasoning: string;
  steps: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}

interface RecoveryAdvisorProps {
  vaultId: string;
}

/**
 * RecoveryAdvisor Component (#290)
 * 
 * Displays staged recovery options for a vault after a shock event.
 * Triggered automatically if an active incident affects the current vault.
 */
export const RecoveryAdvisor: React.FC<RecoveryAdvisorProps> = ({ vaultId }) => {
  const [recommendations, setRecommendations] = useState<RecoveryRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasIncident, setHasIncident] = useState(false);

  useEffect(() => {
    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        // 1. Check for active incidents affecting this vault
        const response = await fetch(`/api/incidents?protocol=${vaultId}&resolved=false`);
        if (!response.ok) throw new Error("Failed to fetch incidents");
        
        const incidents = await response.json();
        
        if (incidents.length > 0) {
          setHasIncident(true);
          // 2. Fetch recommendations for the most recent incident
          const recResponse = await fetch(`/api/incidents/${incidents[0].id}/recommendations`);
          if (recResponse.ok) {
            const data = await recResponse.json();
            setRecommendations(data);
          }
        } else {
          setHasIncident(false);
          setRecommendations([]);
        }
      } catch (err) {
        console.error("RecoveryAdvisor error:", err);
      } finally {
        setLoading(false);
      }
    };

    if (vaultId) {
      fetchRecommendations();
    }
  }, [vaultId]);

  if (loading) {
    return (
      <div className="w-full h-32 bg-white/5 animate-pulse rounded-xl mt-6 border border-white/10 flex items-center justify-center">
        <span className="text-gray-500 text-sm">Analyzing recovery paths...</span>
      </div>
    );
  }

  if (!hasIncident || recommendations.length === 0) return null;

  return (
    <div className="space-y-4 mt-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex items-center space-x-2 text-yellow-400 mb-2">
        <AlertTriangle size={20} className="animate-pulse" />
        <h3 className="text-lg font-bold tracking-tight uppercase">Shock Event Recovery Advisor</h3>
      </div>
      
      <div className="grid grid-cols-1 gap-4">
        {recommendations.map((rec, index) => (
          <div 
            key={index} 
            className={`p-5 rounded-2xl border backdrop-blur-md shadow-lg transition-all hover:scale-[1.01] ${
              rec.riskLevel === 'HIGH' ? 'bg-red-500/10 border-red-500/30' : 
              rec.riskLevel === 'MEDIUM' ? 'bg-yellow-500/10 border-yellow-500/30' : 
              'bg-blue-500/10 border-blue-500/30'
            }`}
          >
            <div className="flex justify-between items-start mb-3">
              <div className="flex items-center space-x-2">
                <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${
                  rec.path === 'UNWIND' ? 'bg-red-500 text-white shadow-red-500/50 shadow-md' :
                  rec.path === 'ROTATE' ? 'bg-purple-600 text-white shadow-purple-500/50 shadow-md' :
                  rec.path === 'REBALANCE' ? 'bg-blue-600 text-white shadow-blue-500/50 shadow-md' :
                  'bg-gray-600 text-white'
                }`}>
                  {rec.path}
                </span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                   rec.riskLevel === 'HIGH' ? 'border-red-500/50 text-red-400' : 
                   rec.riskLevel === 'MEDIUM' ? 'border-yellow-500/50 text-yellow-400' : 
                   'border-blue-500/50 text-blue-400'
                }`}>
                  {rec.riskLevel} RISK
                </span>
              </div>
              <div className="flex items-center space-x-1.5 text-xs font-medium text-white/50 bg-black/20 px-2 py-1 rounded-lg">
                <ShieldCheck size={14} className="text-green-400" />
                <span>{(rec.confidence * 100).toFixed(0)}% Confidence</span>
              </div>
            </div>
            
            <p className="text-sm text-gray-100 mb-4 font-medium leading-relaxed">
              {rec.reasoning}
            </p>
            
            <div className="space-y-2.5 bg-black/20 p-3 rounded-xl border border-white/5">
              <h4 className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-1">Recommended Actions</h4>
              {rec.steps.map((step, sIndex) => (
                <div key={sIndex} className="flex items-start space-x-3 text-xs text-gray-300">
                  <div className="mt-1 p-0.5 bg-white/10 rounded-full">
                    <ArrowRight size={10} className="text-white/60" />
                  </div>
                  <span className="flex-1">{step}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-500 text-center italic">
        Recommendations are generated based on current protocol health and guardrail status.
      </p>
    </div>
  );
};
