import { useState, useEffect, useMemo, Suspense } from "react";
import {
  Wallet,
  TrendingUp,
  ArrowDownToLine,
  ArrowUpFromLine,
  AlertTriangle,
  Clock,
  RefreshCw,
} from "lucide-react";
import { YieldFlowCanvas } from "../visualizations";
import PortfolioVisualizer from "../visualizer/PortfolioVisualizer";
import { ExposureMap } from "../../portfolio/ExposureMap";
import { DailyMovementPanel } from "../../portfolio/DailyMovementPanel";
import PresetsPanel from "../../features/presets/PresetsPanel";
import UnifiedActivityTimeline from "./UnifiedActivityTimeline";
import PortfolioExport from "./PortfolioExport";
import RiskScoreBreakdownPanel from "./RiskScoreBreakdownPanel";
import FreshnessBadge from "./FreshnessBadge";
import { computeHoldingFreshness } from "./holdingFreshness";
import {
  analyzeConcentration,
  buildExposureBuckets,
  formatSharePct,
} from "../../../../shared/types/exposureConcentration";

// ── Types ───────────────────────────────────────────────────────────────

interface VaultPosition {
  protocol: string;
  asset: string;
  deposited: number;
  currentValue: number;
  apy: number;
  shares: number;
  /** ISO-8601 timestamp of when this position's source data was last fetched (#1107). */
  fetchedAt?: string | null;
}

interface Transaction {
  id: string;
  type: "deposit" | "withdraw";
  amount: number;
  asset: string;
  timestamp: string;
  txHash: string;
}

// ── Mock data (will be replaced with on-chain reads in future) ──────────

const MOCK_POSITIONS: VaultPosition[] = [
  {
    protocol: "Blend",
    asset: "USDC",
    deposited: 5000,
    currentValue: 5162.5,
    apy: 6.5,
    shares: 5000,
    fetchedAt: new Date(Date.now() - 60_000).toISOString(), // fresh (1 min ago)
  },
  {
    protocol: "Soroswap",
    asset: "XLM-USDC",
    deposited: 2000,
    currentValue: 2122,
    apy: 12.2,
    shares: 1850,
    fetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // stale (1 hour ago)
  },
  {
    protocol: "DeFindex",
    asset: "Yield Index",
    deposited: 3000,
    currentValue: 3133.5,
    apy: 8.9,
    shares: 2900,
    fetchedAt: null, // unknown — source has never reported a fetch timestamp
  },
];

const MOCK_TRANSACTIONS: Transaction[] = [
  {
    id: "1",
    type: "deposit",
    amount: 5000,
    asset: "USDC",
    timestamp: "2026-03-20T10:30:00Z",
    txHash: "abc123...def456",
  },
  {
    id: "2",
    type: "deposit",
    amount: 2000,
    asset: "XLM-USDC",
    timestamp: "2026-03-18T14:15:00Z",
    txHash: "ghi789...jkl012",
  },
  {
    id: "3",
    type: "withdraw",
    amount: 500,
    asset: "USDC",
    timestamp: "2026-03-15T09:00:00Z",
    txHash: "mno345...pqr678",
  },
  {
    id: "4",
    type: "deposit",
    amount: 3000,
    asset: "Yield Index",
    timestamp: "2026-03-10T16:45:00Z",
    txHash: "stu901...vwx234",
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

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
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Component ───────────────────────────────────────────────────────────

interface PortfolioDashboardProps {
  walletAddress: string;
}

export default function PortfolioDashboard({
  walletAddress,
}: PortfolioDashboardProps) {
  const [positions, setPositions] = useState<VaultPosition[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch daily movement data
  const { movement } = useDailyMovement({ walletAddress, enabled: true });

  useEffect(() => {
    // Simulate loading from chain / backend
    const timer = setTimeout(() => {
      setPositions(MOCK_POSITIONS);
      setTransactions(MOCK_TRANSACTIONS);
      setIsLoading(false);
    }, 800);
    return () => clearTimeout(timer);
  }, [walletAddress]);

  const totalDeposited = positions.reduce((s, p) => s + p.deposited, 0);
  const totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
  const totalYield = totalValue - totalDeposited;
  const avgApy = positions.length
    ? positions.reduce((s, p) => s + p.apy, 0) / positions.length
    : 0;

  const exposure = useMemo(
    () =>
      buildExposureBuckets(positions, (p) => ({
        asset: p.asset,
        protocol: p.protocol,
        valueUsd: p.currentValue,
      })),
    [positions],
  );
  const concentration = useMemo(
    () => analyzeConcentration(exposure),
    [exposure],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw size={32} className="animate-spin text-[#6C5DD3]" />
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="glass-panel p-12 text-center">
        <Wallet className="mx-auto mb-4 text-gray-400" size={48} />
        <h2 className="text-xl font-bold mb-2">No Active Positions</h2>
        <p className="text-gray-400 mb-6">
          Start investing to build your portfolio and earn yield.
        </p>
        <button className="btn-primary">Make Your First Deposit</button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">My Portfolio</h2>
          <p className="text-sm text-gray-400 mt-1 font-mono">
            {walletAddress.slice(0, 8)}...{walletAddress.slice(-8)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PortfolioExport walletAddress={walletAddress} />
          <button
            onClick={() => {
              setIsLoading(true);
              setTimeout(() => setIsLoading(false), 500);
            }}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <Wallet size={14} /> Total Deposited
          </div>
          <p className="text-2xl font-bold">{formatCurrency(totalDeposited)}</p>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <TrendingUp size={14} /> Current Value
          </div>
          <p className="text-2xl font-bold">{formatCurrency(totalValue)}</p>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <ArrowUpFromLine size={14} /> Yield Earned
          </div>
          <p className="text-2xl font-bold text-[#3EAC75]">
            +{formatCurrency(totalYield)}
          </p>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <TrendingUp size={14} /> Avg APY
          </div>
          <p className="text-2xl font-bold">{avgApy.toFixed(1)}%</p>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <AlertTriangle size={14} /> Top Exposure
          </div>
          <p
            className={`text-2xl font-bold ${
              concentration.severity === "critical"
                ? "text-[#FF5E5E]"
                : concentration.severity === "warning"
                  ? "text-yellow-500"
                  : ""
            }`}
          >
            {formatSharePct(
              Math.max(
                concentration.topAssetShare,
                concentration.topProtocolShare,
              ),
            )}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {concentration.warnings.length > 0
              ? `${concentration.warnings.length} concentration warning${concentration.warnings.length > 1 ? "s" : ""}`
              : "Well diversified"}
          </p>
        </div>
      </div>

      {/* Concentration summary */}
      {concentration.warnings.length > 0 && (
        <div
          className={`glass-panel p-5 border-l-4 ${
            concentration.severity === "critical"
              ? "border-[#FF5E5E]"
              : "border-yellow-500"
          }`}
          role="alert"
        >
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle
              size={16}
              className={
                concentration.severity === "critical"
                  ? "text-[#FF5E5E]"
                  : "text-yellow-500"
              }
            />
            <h3 className="font-bold">
              Your portfolio is less diversified than it looks
            </h3>
          </div>
          <ul className="list-disc list-inside space-y-1 text-sm text-gray-300">
            {concentration.warnings.map((warning) => (
              <li key={`${warning.dimension}-${warning.name}`}>
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Daily Movement Panel */}
      {movement && <DailyMovementPanel movement={movement} />}

      <Suspense
        fallback={
          <div className="glass-card animate-pulse" style={{ height: 400 }} />
        }
      >
        <YieldFlowCanvas scene="portfolio" positions={positions} />
      </Suspense>

      {/* Exposure Map */}
      <ExposureMap
        data={{
          byAsset: exposure.byAsset,
          byProtocol: exposure.byProtocol,
          totalValue: exposure.totalValueUsd,
        }}
      />

      <RiskScoreBreakdownPanel />

      {/* 3D Visualizer Integration */}
      <PortfolioVisualizer />

      {/* Positions Table */}
      <div className="glass-panel p-6">
        <h3 className="text-lg font-bold mb-4">Active Positions</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-xs uppercase tracking-wider border-b border-white/10">
                <th className="pb-3 text-left font-semibold">Protocol</th>
                <th className="pb-3 text-left font-semibold">Asset</th>
                <th className="pb-3 text-right font-semibold">Deposited</th>
                <th className="pb-3 text-right font-semibold">Current Value</th>
                <th className="pb-3 text-right font-semibold">APY</th>
                <th className="pb-3 text-right font-semibold">P&L</th>
                <th className="pb-3 text-right font-semibold">Source</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos, i) => {
                const pnl = pos.currentValue - pos.deposited;
                const freshness = computeHoldingFreshness(pos.fetchedAt);
                return (
                  <tr
                    key={i}
                    className="border-b border-white/5 hover:bg-white/5 transition-colors"
                  >
                    <td className="py-4 font-medium">{pos.protocol}</td>
                    <td className="py-4 text-gray-300">{pos.asset}</td>
                    <td className="py-4 text-right">
                      {formatCurrency(pos.deposited)}
                    </td>
                    <td className="py-4 text-right font-medium">
                      {formatCurrency(pos.currentValue)}
                    </td>
                    <td className="py-4 text-right text-[#3EAC75]">
                      {pos.apy}%
                    </td>
                    <td
                      className={`py-4 text-right font-medium ${pnl >= 0 ? "text-[#3EAC75]" : "text-[#FF5E5E]"}`}
                    >
                      {pnl >= 0 ? "+" : ""}
                      {formatCurrency(pnl)}
                    </td>
                    <td className="py-4 text-right">
                      <FreshnessBadge status={freshness.status} ageSeconds={freshness.ageSeconds} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Allocation Presets */}
      <div className="glass-panel p-6">
        <PresetsPanel walletAddress={walletAddress} />
      </div>

      <UnifiedActivityTimeline walletAddress={walletAddress} />

      {/* Transaction History */}
      <div className="glass-panel p-6">
        <h3 className="text-lg font-bold mb-4">Transaction History</h3>
        {transactions.length === 0 ? (
          <p className="text-gray-400 text-center py-6">
            No transactions yet. Start by making your first deposit.
          </p>
        ) : (
          <div className="space-y-3">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between py-3 border-b border-white/5 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      tx.type === "deposit"
                        ? "bg-[#3EAC75]/20 text-[#3EAC75]"
                        : "bg-[#F5A623]/20 text-[#F5A623]"
                    }`}
                  >
                    {tx.type === "deposit" ? (
                      <ArrowDownToLine size={14} />
                    ) : (
                      <ArrowUpFromLine size={14} />
                    )}
                  </div>
                  <div>
                    <p className="font-medium capitalize">{tx.type}</p>
                    <p className="text-xs text-gray-500 font-mono">
                      {tx.txHash}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <p
                    className={`font-medium ${tx.type === "deposit" ? "text-[#3EAC75]" : "text-[#F5A623]"}`}
                  >
                    {tx.type === "deposit" ? "+" : "-"}
                    {formatCurrency(tx.amount)}
                  </p>
                  <p className="text-xs text-gray-500 flex items-center gap-1 justify-end">
                    <Clock size={10} /> {formatDate(tx.timestamp)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
