import { useState, useEffect } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { TrendingUp, TrendingDown, Minus, Info, Calendar, DollarSign, Target } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────

interface AttributionBreakdown {
  decisionType: string;
  contribution: number;
  percentage: number;
  apyImpact: number;
  decisions: Array<{
    id: string;
    type: string;
    timestamp: string;
    protocol: string;
    amount: number;
    expectedApy: number;
    actualApy?: number;
    duration: number;
    confidence: number;
  }>;
  confidence: number;
}

interface RewardSourceMixEntry {
  rewardSource: string;
  contribution: number;
  percentage: number;
  confidence: number;
}

interface AttributionReport {
  walletAddress: string;
  totalReturn: number;
  totalDeposited: number;
  attributionBreakdown: AttributionBreakdown[];
  rewardSourceMix?: RewardSourceMixEntry[];
  timeWindow: {
    start: string;
    end: string;
  };
  generatedAt: string;
  dataCompleteness: number;
}

interface PortfolioAttributionPanelProps {
  walletAddress: string;
}

// ── Configuration ───────────────────────────────────────────────────────

const DECISION_TYPE_COLORS = {
  initial_routing: "#6C5DD3",
  rotation: "#3EAC75", 
  incentive_capture: "#F5A623",
  hold: "#FF5E5E",
};

const DECISION_TYPE_LABELS = {
  initial_routing: "Initial Routing",
  rotation: "Strategy Rotation",
  incentive_capture: "Incentive Capture",
  hold: "Hold Strategy",
};

const REWARD_SOURCE_COLORS: Record<string, string> = {
  base_protocol_yield: "#6C5DD3",
  incentive_emissions: "#F5A623",
  tactical_routing: "#3EAC75",
  fees: "#FF5E5E",
};

const REWARD_SOURCE_LABELS: Record<string, string> = {
  base_protocol_yield: "Base Protocol Yield",
  incentive_emissions: "Incentive Emissions",
  tactical_routing: "Tactical Routing",
  fees: "Embedded Fees",
};

// ── Helpers ───────────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getTrendIcon(percentage: number) {
  if (percentage > 0) return <TrendingUp size={16} className="text-[#3EAC75]" />;
  if (percentage < 0) return <TrendingDown size={16} className="text-[#FF5E5E]" />;
  return <Minus size={16} className="text-gray-400" />;
}

// ── Component ───────────────────────────────────────────────────────────

export default function PortfolioAttributionPanel({ walletAddress }: PortfolioAttributionPanelProps) {
  const [report, setReport] = useState<AttributionReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeWindow, setTimeWindow] = useState({
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
    end: new Date().toISOString(),
  });

  useEffect(() => {
    fetchAttributionReport();
  }, [walletAddress, timeWindow]);

  const fetchAttributionReport = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(
        `/api/analytics/attribution/${walletAddress}?startTime=${timeWindow.start}&endTime=${timeWindow.end}`
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setReport(data.data);
    } catch (err) {
      console.error("Failed to fetch attribution report:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch attribution report");
    } finally {
      setIsLoading(false);
    }
  };

  const handleTimeWindowChange = (days: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    
    setTimeWindow({
      start: start.toISOString(),
      end: end.toISOString(),
    });
  };

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
          <Info className="mx-auto mb-4 text-red-400" size={48} />
          <h3 className="text-lg font-semibold mb-2">Attribution Data Unavailable</h3>
          <p className="text-gray-400 mb-4">{error}</p>
          <button onClick={fetchAttributionReport} className="btn-primary">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="glass-panel p-8">
        <div className="text-center py-12">
          <Target className="mx-auto mb-4 text-gray-400" size={48} />
          <h3 className="text-lg font-semibold mb-2">No Attribution Data</h3>
          <p className="text-gray-400">No strategy decisions found in the selected time window.</p>
        </div>
      </div>
    );
  }

  // Prepare chart data
  const pieChartData = (report.rewardSourceMix?.length
    ? report.rewardSourceMix
    : report.attributionBreakdown
  ).map((entry: any) => {
    if ("rewardSource" in entry) {
      return {
        name:
          REWARD_SOURCE_LABELS[entry.rewardSource] || entry.rewardSource,
        value: entry.contribution,
        percentage: entry.percentage,
        color:
          REWARD_SOURCE_COLORS[entry.rewardSource] || "#6C5DD3",
      };
    }

    return {
      name:
        DECISION_TYPE_LABELS[
          entry.decisionType as keyof typeof DECISION_TYPE_LABELS
        ] || entry.decisionType,
      value: entry.contribution,
      percentage: entry.percentage,
      color:
        DECISION_TYPE_COLORS[
          entry.decisionType as keyof typeof DECISION_TYPE_COLORS
        ] || "#6C5DD3",
    };
  });

  const barChartData = report.attributionBreakdown.map(breakdown => ({
    name: DECISION_TYPE_LABELS[breakdown.decisionType as keyof typeof DECISION_TYPE_LABELS] || breakdown.decisionType,
    contribution: breakdown.contribution,
    apyImpact: breakdown.apyImpact,
    confidence: breakdown.confidence * 100,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Portfolio Attribution</h2>
          <p className="text-sm text-gray-400 mt-1">
            Performance breakdown by strategy decisions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-gray-400" />
          <select
            value={Math.ceil((new Date(timeWindow.end).getTime() - new Date(timeWindow.start).getTime()) / (24 * 60 * 60 * 1000))}
            onChange={(e) => handleTimeWindowChange(Number(e.target.value))}
            className="bg-white/10 border border-white/20 rounded px-3 py-1 text-sm"
          >
            <option value={7}>7 Days</option>
            <option value={30}>30 Days</option>
            <option value={90}>90 Days</option>
            <option value={365}>1 Year</option>
          </select>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <DollarSign size={14} /> Total Return
          </div>
          <p className="text-xl font-bold text-[#3EAC75]">
            {formatCurrency(report.totalReturn)}
          </p>
          <div className="flex items-center gap-1 mt-1">
            {getTrendIcon(report.totalReturn)}
            <span className="text-xs text-gray-400">
              {report.totalDeposited > 0 ? 
                `${((report.totalReturn / report.totalDeposited) * 100).toFixed(1)}%` : 
                "N/A"
              }
            </span>
          </div>
        </div>

        <div className="glass-card p-4">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <Target size={14} /> Total Deposited
          </div>
          <p className="text-xl font-bold">
            {formatCurrency(report.totalDeposited)}
          </p>
        </div>

        <div className="glass-card p-4">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <Info size={14} /> Data Completeness
          </div>
          <p className="text-xl font-bold">
            {(report.dataCompleteness * 100).toFixed(1)}%
          </p>
          <div className="w-full bg-white/20 rounded-full h-2 mt-2">
            <div 
              className="bg-[#6C5DD3] h-2 rounded-full transition-all duration-300"
              style={{ width: `${report.dataCompleteness * 100}%` }}
            />
          </div>
        </div>

        <div className="glass-card p-4">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <TrendingUp size={14} /> Decision Types
          </div>
          <p className="text-xl font-bold">
            {report.attributionBreakdown.length}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {report.attributionBreakdown.reduce((sum, b) => sum + b.decisions.length, 0)} total decisions
          </p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pie Chart */}
        <div className="glass-panel p-6">
          <h3 className="text-lg font-semibold mb-4">
            Return Attribution by Reward Source
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieChartData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percentage }) => `${name}: ${percentage.toFixed(1)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {pieChartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Bar Chart */}
        <div className="glass-panel p-6">
          <h3 className="text-lg font-semibold mb-4">Performance Metrics by Decision Type</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={barChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="name" tick={{ fill: "#9CA3AF", fontSize: 12 }} />
              <YAxis tick={{ fill: "#9CA3AF", fontSize: 12 }} />
              <Tooltip 
                contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151" }}
                labelStyle={{ color: "#F3F4F6" }}
              />
              <Bar dataKey="contribution" fill="#6C5DD3" name="Contribution ($)" />
              <Bar dataKey="apyImpact" fill="#3EAC75" name="APY Impact (%)" />
              <Bar dataKey="confidence" fill="#F5A623" name="Confidence (%)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Detailed Breakdown */}
      <div className="glass-panel p-6">
        <h3 className="text-lg font-semibold mb-4">Detailed Attribution Breakdown</h3>
        <div className="space-y-4">
          {report.attributionBreakdown.map((breakdown, index) => (
            <div key={index} className="border border-white/10 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div 
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: DECISION_TYPE_COLORS[breakdown.decisionType as keyof typeof DECISION_TYPE_COLORS] || "#6C5DD3" }}
                  />
                  <h4 className="font-semibold">
                    {DECISION_TYPE_LABELS[breakdown.decisionType as keyof typeof DECISION_TYPE_LABELS] || breakdown.decisionType}
                  </h4>
                  <span className="text-sm text-gray-400">
                    {breakdown.decisions.length} decisions
                  </span>
                </div>
                <div className="text-right">
                  <p className="font-bold text-lg">{formatCurrency(breakdown.contribution)}</p>
                  <p className="text-sm text-gray-400">{breakdown.percentage.toFixed(1)}% of total</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">APY Impact</p>
                  <p className="font-semibold">{breakdown.apyImpact.toFixed(2)}%</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Confidence</p>
                  <div className="flex items-center gap-2">
                    <div className="w-full bg-white/20 rounded-full h-2 max-w-20">
                      <div 
                        className="bg-[#3EAC75] h-2 rounded-full"
                        style={{ width: `${breakdown.confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-sm">{(breakdown.confidence * 100).toFixed(0)}%</span>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Avg Decision Size</p>
                  <p className="font-semibold">
                    {formatCurrency(breakdown.decisions.reduce((sum, d) => sum + d.amount, 0) / breakdown.decisions.length)}
                  </p>
                </div>
              </div>

              {/* Recent Decisions */}
              <div className="border-t border-white/10 pt-3">
                <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Recent Decisions</p>
                <div className="space-y-2">
                  {breakdown.decisions.slice(0, 3).map((decision, decisionIndex) => (
                    <div key={decisionIndex} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400">{formatDate(decision.timestamp)}</span>
                        <span className="text-gray-300">{decision.protocol}</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span>{formatCurrency(decision.amount)}</span>
                        <span className="text-[#3EAC75]">{decision.actualApy || decision.expectedApy}%</span>
                      </div>
                    </div>
                  ))}
                  {breakdown.decisions.length > 3 && (
                    <p className="text-xs text-gray-400">
                      +{breakdown.decisions.length - 3} more decisions
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer Info */}
      <div className="text-center text-xs text-gray-400">
        <p>
          Generated on {formatDate(report.generatedAt)} • 
          Data completeness: {(report.dataCompleteness * 100).toFixed(1)}% • 
          Time window: {formatDate(timeWindow.start)} - {formatDate(timeWindow.end)}
        </p>
      </div>
    </div>
  );
}
