import { useState, useEffect, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useWallet } from "../../context/useWallet";
import { TrendingUp, TrendingDown, Loader2, DollarSign } from "lucide-react";
import { getApiBaseUrl } from "../../lib/api";

interface DailyPnLSnapshot {
  date: string;
  cumulativePnL: number;
  portfolioValue: number;
  sharePrice: number;
}

interface PnLData {
  totalDeposited: number;
  totalWithdrawn: number;
  currentValue: number;
  costBasis: number;
  absolutePnL: number;
  twrPercent: number;
  dailySnapshots: DailyPnLSnapshot[];
}

const API_BASE = getApiBaseUrl();

/**
 * PnLChart — Visualizes a user's historical profit & loss with an area chart.
 *
 * Shows total deposited, withdrawn, current value, absolute PnL, and
 * Time-Weighted Return, alongside a daily cumulative PnL chart.
 */
export default function PnLChart() {
  const { isConnected, walletAddress } = useWallet();
  const [pnlData, setPnlData] = useState<PnLData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPnL = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/users/${encodeURIComponent(walletAddress)}/pnl`,
      );
      if (!res.ok) {
        throw new Error("Failed to fetch PnL data");
      }
      const data: PnLData = await res.json();
      setPnlData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch PnL data");
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (isConnected && walletAddress) {
      void fetchPnL();
    }
  }, [isConnected, walletAddress, fetchPnL]);

  if (!isConnected) {
    return (
      <div className="glass-panel p-8 text-center">
        <DollarSign className="mx-auto mb-4 text-indigo-400" size={48} />
        <h2 className="text-xl font-bold mb-2">Profit & Loss</h2>
        <p className="text-gray-400">
          Connect your wallet to view your historical PnL.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="glass-panel p-8 text-center">
        <Loader2
          className="mx-auto mb-4 animate-spin text-indigo-400"
          size={48}
        />
        <p className="text-gray-400">Calculating your PnL...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel p-8 text-center">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (!pnlData || (pnlData.dailySnapshots.length === 0 && pnlData.totalDeposited === 0)) {
    return (
      <div className="glass-panel p-8 text-center">
        <DollarSign className="mx-auto mb-4 text-gray-400" size={48} />
        <h2 className="text-xl font-bold mb-2">No P&L Data Yet</h2>
        <p className="text-gray-400">Make your first deposit to start tracking your profit and loss.</p>
      </div>
    );
  }

  const isProfit = pnlData.absolutePnL >= 0;
  const pnlColor = isProfit ? "text-green-400" : "text-red-400";
  const chartColor = isProfit ? "#4ade80" : "#f87171";
  const chartGradient = isProfit
    ? "url(#profitGradient)"
    : "url(#lossGradient)";

  return (
    <div className="glass-panel p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <DollarSign className="text-indigo-400" size={24} />
          Profit & Loss
        </h2>
        {isProfit ? (
          <TrendingUp className="text-green-400" size={24} />
        ) : (
          <TrendingDown className="text-red-400" size={24} />
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Deposited" value={`$${fmt(pnlData.totalDeposited)}`} />
        <StatCard label="Total Withdrawn" value={`$${fmt(pnlData.totalWithdrawn)}`} />
        <StatCard
          label="Current Value"
          value={`$${fmt(pnlData.currentValue)}`}
          highlight
        />
        <StatCard
          label="Absolute PnL"
          value={`${isProfit ? "+" : ""}$${fmt(pnlData.absolutePnL)}`}
          className={pnlColor}
        />
      </div>

      {/* TWR Badge */}
      <div className="flex items-center gap-3">
        <span className="text-gray-400 text-sm">Time-Weighted Return:</span>
        <span className={`text-lg font-bold ${pnlColor}`}>
          {pnlData.twrPercent >= 0 ? "+" : ""}
          {pnlData.twrPercent.toFixed(2)}%
        </span>
      </div>

      {/* PnL Chart */}
      {loading ? (
        <div className="h-64 w-full animate-pulse bg-gradient-to-r from-gray-700/30 via-gray-600/30 to-gray-700/30 rounded-lg" />
      ) : pnlData.dailySnapshots.length > 0 ? (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={pnlData.dailySnapshots}>
              <defs>
                <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4ade80" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="lossGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f87171" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f87171" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#9ca3af", fontSize: 12 }}
                tickFormatter={(val: string) => val.slice(5)}
              />
              <YAxis
                tick={{ fill: "#9ca3af", fontSize: 12 }}
                tickFormatter={(val: number) => `$${val.toFixed(0)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: "8px",
                }}
                labelStyle={{ color: "#9ca3af" }}
                formatter={(value: number) => [`$${value.toFixed(2)}`, "PnL"]}
              />
              <Area
                type="monotone"
                dataKey="cumulativePnL"
                stroke={chartColor}
                fill={chartGradient}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-gray-400 text-center py-12">No daily PnL data available.</p>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  className,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`bg-white/5 rounded-xl p-4 ${highlight ? "ring-1 ring-indigo-500/30" : ""}`}
    >
      <p className="text-gray-400 text-xs mb-1">{label}</p>
      <p className={`text-lg font-bold ${className || "text-white"}`}>
        {value}
      </p>
    </div>
  );
}

/** Format number with commas and 2 decimal places. */
function fmt(n: number): string {
  return Math.abs(n)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
