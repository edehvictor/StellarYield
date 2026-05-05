import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar } from "recharts";
import { Activity, AlertTriangle, CheckCircle, XCircle, TrendingUp, TrendingDown, Minus, RefreshCw, Settings } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────

interface StrategyHealthMetrics {
  contractSafety: number;
  dataFreshness: number;
  providerUptime: number;
  liquidityConditions: number;
  executionOutcomes: number;
  volatilityIndex: number;
  errorRate: number;
  latency: number;
}

interface StrategyHealthScore {
  strategyId: string;
  strategyName: string;
  overallScore: number;
  metrics: StrategyHealthMetrics;
  status: 'healthy' | 'degraded' | 'critical' | 'disabled';
  signals: Array<{
    source: string;
    metric: string;
    value: number;
    weight: number;
    threshold: {
      critical: number;
      warning: number;
      good: number;
    };
    timestamp: string;
    reliability: number;
  }>;
  lastUpdated: string;
  trend: 'improving' | 'stable' | 'declining';
  recommendations: string[];
  suppressUntil?: string;
}

interface StrategyHealthPanelProps {
  strategyIds?: string[];
}

// ── Configuration ───────────────────────────────────────────────────────

const STATUS_COLORS = {
  healthy: "#3EAC75",
  degraded: "#F5A623",
  critical: "#FF5E5E",
  disabled: "#6B7280",
};

const STATUS_ICONS = {
  healthy: <CheckCircle size={16} className="text-[#3EAC75]" />,
  degraded: <AlertTriangle size={16} className="text-[#F5A623]" />,
  critical: <XCircle size={16} className="text-[#FF5E5E]" />,
  disabled: <XCircle size={16} className="text-[#6B7280]" />,
};

// ── Helpers ───────────────────────────────────────────────────────────────

function getTrendIcon(trend: 'improving' | 'stable' | 'declining') {
  switch (trend) {
    case 'improving': return <TrendingUp size={14} className="text-[#3EAC75]" />;
    case 'declining': return <TrendingDown size={14} className="text-[#FF5E5E]" />;
    default: return <Minus size={14} className="text-gray-400" />;
  }
}

function getStatusColor(score: number): string {
  if (score >= 80) return STATUS_COLORS.healthy;
  if (score >= 60) return STATUS_COLORS.degraded;
  if (score >= 40) return STATUS_COLORS.critical;
  return STATUS_COLORS.disabled;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Component ───────────────────────────────────────────────────────────

export default function StrategyHealthPanel({ strategyIds = ['strategy_1', 'strategy_2', 'strategy_3', 'strategy_4'] }: StrategyHealthPanelProps) {
  const [healthScores, setHealthScores] = useState<StrategyHealthScore[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyHealthScore | null>(null);

  useEffect(() => {
    fetchHealthScores();
  }, [strategyIds]);

  const fetchHealthScores = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/analytics/health/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ strategyIds }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setHealthScores(data.data);
      
      // Select first strategy by default
      if (data.data.length > 0) {
        setSelectedStrategy(data.data[0]);
      }
    } catch (err) {
      console.error("Failed to fetch health scores:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch health scores");
    } finally {
      setIsLoading(false);
    }
  };

  const getRadarData = (metrics: StrategyHealthMetrics) => [
    { metric: 'Contract Safety', value: metrics.contractSafety * 100, fullMark: 100 },
    { metric: 'Data Freshness', value: metrics.dataFreshness * 100, fullMark: 100 },
    { metric: 'Provider Uptime', value: metrics.providerUptime * 100, fullMark: 100 },
    { metric: 'Liquidity', value: metrics.liquidityConditions * 100, fullMark: 100 },
    { metric: 'Execution', value: metrics.executionOutcomes * 100, fullMark: 100 },
    { metric: 'Low Volatility', value: (1 - metrics.volatilityIndex) * 100, fullMark: 100 },
  ];

  if (isLoading) {
    return (
      <div className="glass-panel p-8">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6C5DD3]"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel p-8">
        <div className="text-center py-12">
          <AlertTriangle className="mx-auto mb-4 text-red-400" size={48} />
          <h3 className="text-lg font-semibold mb-2">Health Data Unavailable</h3>
          <p className="text-gray-400 mb-4">{error}</p>
          <button onClick={fetchHealthScores} className="btn-primary">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (healthScores.length === 0) {
    return (
      <div className="glass-panel p-8">
        <div className="text-center py-12">
          <Activity className="mx-auto mb-4 text-gray-400" size={48} />
          <h3 className="text-lg font-semibold mb-2">No Health Data</h3>
          <p className="text-gray-400">No strategies found or health data unavailable.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Strategy Health Monitor</h2>
          <p className="text-sm text-gray-400 mt-1">
            Real-time health monitoring for all strategies
          </p>
        </div>
        <button onClick={fetchHealthScores} className="btn-secondary flex items-center gap-2">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Strategy Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {healthScores.map((score) => (
          <div
            key={score.strategyId}
            className={`glass-card p-4 cursor-pointer transition-all duration-200 ${
              selectedStrategy?.strategyId === score.strategyId ? 'ring-2 ring-[#6C5DD3]' : 'hover:bg-white/5'
            }`}
            onClick={() => setSelectedStrategy(score)}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {STATUS_ICONS[score.status]}
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {score.status}
                </span>
              </div>
              {getTrendIcon(score.trend)}
            </div>
            
            <h3 className="font-semibold mb-1">{score.strategyName}</h3>
            
            <div className="flex items-end justify-between">
              <div>
                <p className="text-2xl font-bold" style={{ color: getStatusColor(score.overallScore) }}>
                  {score.overallScore}
                </p>
                <p className="text-xs text-gray-400">Health Score</p>
              </div>
              
              <div className="w-12 h-12">
                <svg viewBox="0 0 36 36" className="transform -rotate-90">
                  <path
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    fill="none"
                    stroke="#ffffff20"
                    strokeWidth="3"
                  />
                  <path
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    fill="none"
                    stroke={getStatusColor(score.overallScore)}
                    strokeWidth="3"
                    strokeDasharray={`${score.overallScore}, 100`}
                  />
                </svg>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Detailed View */}
      {selectedStrategy && (
        <div className="glass-panel p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-semibold">{selectedStrategy.strategyName}</h3>
              <p className="text-sm text-gray-400">
                Last updated: {new Date(selectedStrategy.lastUpdated).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {STATUS_ICONS[selectedStrategy.status]}
              <span className="text-lg font-bold" style={{ color: getStatusColor(selectedStrategy.overallScore) }}>
                {selectedStrategy.overallScore}/100
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Metrics Radar Chart */}
            <div>
              <h4 className="font-semibold mb-4">Performance Metrics</h4>
              <ResponsiveContainer width="100%" height={300}>
                <RadarChart data={getRadarData(selectedStrategy.metrics)}>
                  <PolarGrid stroke="#ffffff20" />
                  <PolarAngleAxis dataKey="metric" tick={{ fill: "#9CA3AF", fontSize: 12 }} />
                  <PolarRadiusAxis 
                    angle={90} 
                    domain={[0, 100]} 
                    tick={{ fill: "#9CA3AF", fontSize: 10 }}
                  />
                  <Radar
                    name="Health Score"
                    dataKey="value"
                    stroke={getStatusColor(selectedStrategy.overallScore)}
                    fill={getStatusColor(selectedStrategy.overallScore)}
                    fillOpacity={0.3}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151" }}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>

            {/* Detailed Metrics */}
            <div>
              <h4 className="font-semibold mb-4">Detailed Metrics</h4>
              <div className="space-y-3">
                {Object.entries(selectedStrategy.metrics).map(([metric, value]) => {
                  const displayName = metric.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
                  const isPercentage = ['contractSafety', 'dataFreshness', 'providerUptime', 'liquidityConditions', 'executionOutcomes'].includes(metric);
                  const isErrorRate = metric === 'errorRate';
                  const isLatency = metric === 'latency';
                  const isVolatility = metric === 'volatilityIndex';
                  
                  let displayValue: string;
                  let color: string = "#3EAC75";
                  
                  if (isPercentage) {
                    displayValue = `${(value * 100).toFixed(1)}%`;
                    color = value >= 0.8 ? "#3EAC75" : value >= 0.6 ? "#F5A623" : "#FF5E5E";
                  } else if (isErrorRate) {
                    displayValue = `${(value * 100).toFixed(2)}%`;
                    color = value <= 0.01 ? "#3EAC75" : value <= 0.05 ? "#F5A623" : "#FF5E5E";
                  } else if (isLatency) {
                    displayValue = formatLatency(value);
                    color = value <= 200 ? "#3EAC75" : value <= 500 ? "#F5A623" : "#FF5E5E";
                  } else if (isVolatility) {
                    displayValue = `${(value * 100).toFixed(1)}%`;
                    color = value <= 0.3 ? "#3EAC75" : value <= 0.5 ? "#F5A623" : "#FF5E5E";
                  } else {
                    displayValue = value.toString();
                    color = "#9CA3AF";
                  }

                  return (
                    <div key={metric} className="flex items-center justify-between">
                      <span className="text-sm text-gray-300">{displayName}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold" style={{ color }}>
                          {displayValue}
                        </span>
                        <div className="w-16 bg-white/20 rounded-full h-2">
                          <div 
                            className="h-2 rounded-full transition-all duration-300"
                            style={{ 
                              width: `${isPercentage || isErrorRate || isVolatility ? value * 100 : Math.min(100, (value / 1000) * 100)}%`,
                              backgroundColor: color 
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Recommendations */}
          {selectedStrategy.recommendations.length > 0 && (
            <div className="mt-6 border-t border-white/10 pt-6">
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <Settings size={16} />
                Recommendations
              </h4>
              <div className="space-y-2">
                {selectedStrategy.recommendations.map((recommendation, index) => (
                  <div key={index} className="flex items-start gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-[#F5A623] mt-1.5 flex-shrink-0" />
                    <span className="text-gray-300">{recommendation}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recent Signals */}
      <div className="glass-panel p-6">
        <h3 className="text-lg font-semibold mb-4">Recent Health Signals</h3>
        <div className="space-y-3">
          {selectedStrategy?.signals.slice(0, 5).map((signal, index) => (
            <div key={index} className="flex items-center justify-between text-sm border-b border-white/5 pb-2">
              <div className="flex items-center gap-3">
                <span className="text-gray-400">{signal.source}</span>
                <span className="text-gray-300">{signal.metric}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="font-semibold">{signal.value}</span>
                <span className="text-gray-400">
                  {new Date(signal.timestamp).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
