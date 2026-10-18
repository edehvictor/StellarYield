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
import PortfolioImport from "./PortfolioImport";
import RiskScoreBreakdownPanel from "./RiskScoreBreakdownPanel";
import FreshnessBadge from "./FreshnessBadge";
import { computeHoldingFreshness } from "./holdingFreshness";
import { useDailyMovement } from "../../hooks/useDailyMovement";
import {
  analyzeConcentration,
  buildExposureBuckets,
  formatSharePct,
} from "../../../../shared/types/exposureConcentration";
import {
  computePortfolioValuationSummary,
  resolvePositionValuation,
  type ValuationPriceStatus,
} from "../../../../shared/types/portfolioValuation";
import {
  describeValuationFailure,
  type PortfolioValuationFailure,
} from "../../portfolio/portfolioValuationErrors";

// ── Types ───────────────────────────────────────────────────────────────

export interface VaultPosition {
  protocol: string;
  asset: string;
  deposited: number;
  /**
   * Current valuation in USD.
   * `null` or `undefined` indicates price/valuation is unavailable (not zero!).
   * A value of `0` indicates a genuine zero balance (#1660).
   */
  currentValue: number | null;
  apy: number;
  shares: number;
  /** ISO-8601 timestamp of when this position's source data was last fetched (#1107). */
  fetchedAt?: string | null;
  /** Explicit price unavailability override (#1660). */
  isPriceUnavailable?: boolean;
  /** Explicit valuation price status (#1660). */
  priceStatus?: ValuationPriceStatus;
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
  initialPositions?: VaultPosition[];
  onRefresh?: () => Promise<VaultPosition[]>;
}

export default function PortfolioDashboard({
  walletAddress,
  initialPositions,
  onRefresh,
}: PortfolioDashboardProps) {
  const [positions, setPositions] = useState<VaultPosition[]>(initialPositions ?? []);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(!initialPositions);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<PortfolioValuationFailure | null>(null);

  // Fetch daily movement data
  const { movement } = useDailyMovement({ walletAddress, enabled: true });

  useEffect(() => {
    if (initialPositions) {
      setPositions(initialPositions);
      setTransactions(MOCK_TRANSACTIONS);
      setIsLoading(false);
      return;
    }

    // Simulate loading from chain / backend
    const timer = setTimeout(() => {
      setPositions(MOCK_POSITIONS);
      setTransactions(MOCK_TRANSACTIONS);
      setIsLoading(false);
    }, 800);
    return () => clearTimeout(timer);
  }, [walletAddress, initialPositions]);

  const valuationSummary = useMemo(
    () =>
      computePortfolioValuationSummary(
        positions.map((p) => ({
          protocol: p.protocol,
          asset: p.asset,
          deposited: p.deposited,
          currentValue: p.currentValue,
          shares: p.shares,
          apy: p.apy,
          fetchedAt: p.fetchedAt,
          isPriceUnavailable: p.isPriceUnavailable,
          priceStatus: p.priceStatus,
        })),
      ),
    [positions],
  );

  const avgApy = positions.length
    ? positions.reduce((s, p) => s + (p.apy || 0), 0) / positions.length
    : 0;

  const exposure = useMemo(
    () =>
      buildExposureBuckets(
        positions.filter(
          (p) =>
            p.currentValue !== null &&
            p.currentValue !== undefined &&
            !p.isPriceUnavailable &&
            p.priceStatus !== "unpriced",
        ),
        (p) => ({
          asset: p.asset,
          protocol: p.protocol,
          valueUsd: p.currentValue ?? 0,
        }),
      ),
    [positions],
  );

  const concentration = useMemo(
    () => analyzeConcentration(exposure),
    [exposure],
  );

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      if (onRefresh) {
        const updated = await onRefresh();
        setPositions(updated);
        setRefreshError(null);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 400));
        setRefreshError(null);
      }
    } catch (err) {
      // PRESERVE existing positions in state on failure (#1660)
      const failure = describeValuationFailure(err);
      setRefreshError(failure);
    } finally {
      setIsRefreshing(false);
    }
  };

  const showEmptyState = !isLoading && positions.length === 0;

  const canvasPositions = useMemo(
    () =>
      positions.map((p) => ({
        ...p,
        currentValue: p.currentValue ?? p.deposited,
      })),
    [positions],
  );

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
          <PortfolioImport />
          <PortfolioExport walletAddress={walletAddress} />
          <button
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50"
            data-testid="refresh-portfolio-button"
          >
            <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* State-preserving refresh failure alert (#1660) */}
      {refreshError && (
        <div
          className="glass-panel p-4 border-l-4 border-red-500 bg-red-500/10 flex items-center justify-between"
          role="alert"
          data-testid="valuation-refresh-error-banner"
        >
          <div className="flex items-center gap-2 text-sm text-red-200">
            <AlertTriangle size={16} className="text-red-400 shrink-0" />
            <span>{refreshError.message}</span>
          </div>
          <div className="flex items-center gap-3">
            {refreshError.retryable && (
              <button
                onClick={() => void handleRefresh()}
                className="text-xs bg-white/10 hover:bg-white/20 text-white px-2.5 py-1 rounded transition-colors"
                data-testid="retry-refresh-button"
              >
                Retry
              </button>
            )}
            <button
              onClick={() => setRefreshError(null)}
              className="text-xs text-gray-400 hover:text-white"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Position-dependent section (issue #1151): scoped loading/empty
          states so a slow or failed position fetch never blocks the
          independently-fetching widgets rendered below it. */}
      {isLoading ? (
        <div
          className="glass-panel flex items-center justify-center py-16"
          data-testid="positions-section-loading"
        >
          <RefreshCw size={28} className="animate-spin text-[#6C5DD3]" />
          <span className="ml-3 text-sm text-gray-400">Loading portfolio positions…</span>
        </div>
      ) : showEmptyState ? (
        <div className="glass-panel p-12 text-center" data-testid="positions-section-empty">
          <Wallet className="mx-auto mb-4 text-gray-400" size={48} />
          <h2 className="text-xl font-bold mb-2">No Active Positions</h2>
          <p className="text-gray-400 mb-6">
            Start investing to build your portfolio and earn yield.
          </p>
          <button className="btn-primary">Make Your First Deposit</button>
        </div>
      ) : (
        <div className="space-y-8" data-testid="positions-section">
          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="glass-card p-5">
              <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
                <Wallet size={14} /> Total Deposited
              </div>
              <p className="text-2xl font-bold">{formatCurrency(valuationSummary.totalDepositedUsd)}</p>
            </div>

            <div className="glass-card p-5" data-testid="current-value-card">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider">
                  <TrendingUp size={14} /> Current Value
                </div>
                {valuationSummary.completeness === "partial" && (
                  <span
                    className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30"
                    data-testid="incomplete-valuation-badge"
                  >
                    Incomplete
                  </span>
                )}
              </div>
              {valuationSummary.completeness === "unavailable" ? (
                <div>
                  <p className="text-2xl font-bold text-gray-400" data-testid="total-value-unavailable">
                    Unavailable
                  </p>
                  <p className="text-xs text-amber-400/90 mt-1 flex items-center gap-1">
                    <AlertTriangle size={12} /> Prices offline
                  </p>
                </div>
              ) : (
                <div>
                  <p
                    className="text-2xl font-bold"
                    data-testid={
                      valuationSummary.completeness === "partial"
                        ? "total-value-partial"
                        : "total-value-complete"
                    }
                  >
                    {formatCurrency(valuationSummary.pricedValueUsd)}
                    {valuationSummary.completeness === "partial" ? "*" : ""}
                  </p>
                  {valuationSummary.completeness === "partial" ? (
                    <p className="text-xs text-amber-400/90 mt-1" data-testid="partial-valuation-notice">
                      Excludes {valuationSummary.unpricedCount} unpriced holding{valuationSummary.unpricedCount > 1 ? "s" : ""}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 mt-1">Fully priced</p>
                  )}
                </div>
              )}
            </div>

            <div className="glass-card p-5" data-testid="yield-earned-card">
              <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
                <ArrowUpFromLine size={14} /> Yield Earned
              </div>
              {valuationSummary.completeness === "unavailable" ? (
                <div>
                  <p className="text-2xl font-bold text-gray-400" data-testid="yield-earned-unavailable">
                    —
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Valuation unavailable</p>
                </div>
              ) : (
                <div>
                  <p
                    className={`text-2xl font-bold ${
                      (valuationSummary.yieldEarnedUsd ?? 0) >= 0 ? "text-[#3EAC75]" : "text-[#FF5E5E]"
                    }`}
                    data-testid={
                      valuationSummary.completeness === "partial"
                        ? "yield-earned-partial"
                        : "yield-earned-complete"
                    }
                  >
                    {(valuationSummary.yieldEarnedUsd ?? 0) >= 0 ? "+" : ""}
                    {formatCurrency(valuationSummary.yieldEarnedUsd ?? 0)}
                    {valuationSummary.completeness === "partial" ? "*" : ""}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {valuationSummary.completeness === "partial"
                      ? "On priced holdings"
                      : "Across all holdings"}
                  </p>
                </div>
              )}
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

          {/* Incomplete / Unavailable Valuation Notice (#1660) */}
          {valuationSummary.completeness === "partial" && (
            <div
              className="glass-panel p-4 border-l-4 border-amber-500 bg-amber-500/5 flex items-center justify-between gap-3"
              role="alert"
              data-testid="valuation-incomplete-banner"
            >
              <div className="flex items-center gap-3">
                <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                <div>
                  <h4 className="font-semibold text-amber-300 text-sm">
                    Incomplete Portfolio Valuation
                  </h4>
                  <p className="text-xs text-gray-300 mt-0.5">
                    Live market prices are unavailable for {valuationSummary.unpricedAssets.join(", ")}.
                    Stated totals and yield reflect priced assets only.
                  </p>
                </div>
              </div>
              <span className="text-xs px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 font-mono whitespace-nowrap">
                {valuationSummary.unpricedCount} unpriced
              </span>
            </div>
          )}
          {valuationSummary.completeness === "unavailable" && (
            <div
              className="glass-panel p-4 border-l-4 border-amber-500 bg-amber-500/5 flex items-center justify-between gap-3"
              role="alert"
              data-testid="valuation-incomplete-banner"
            >
              <div className="flex items-center gap-3">
                <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                <div>
                  <h4 className="font-semibold text-amber-300 text-sm">
                    Valuations Temporarily Unavailable
                  </h4>
                  <p className="text-xs text-gray-300 mt-0.5">
                    Pricing feeds for all active holdings are currently unreachable. Deposited balances remain intact.
                  </p>
                </div>
              </div>
              <span className="text-xs px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 font-mono whitespace-nowrap">
                All unpriced
              </span>
            </div>
          )}

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
            <YieldFlowCanvas scene="portfolio" positions={canvasPositions} />
          </Suspense>

          {/* Exposure Map */}
          <ExposureMap
            data={{
              byAsset: exposure.byAsset,
              byProtocol: exposure.byProtocol,
              totalValue: exposure.totalValueUsd,
              warnings:
                valuationSummary.unpricedCount > 0
                  ? [
                      `Exposure calculation excludes ${valuationSummary.unpricedCount} unpriced holding${
                        valuationSummary.unpricedCount > 1 ? "s" : ""
                      } (${valuationSummary.unpricedAssets.join(", ")})`,
                    ]
                  : undefined,
            }}
          />

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
                    const resolved = resolvePositionValuation({
                      protocol: pos.protocol,
                      asset: pos.asset,
                      deposited: pos.deposited,
                      currentValue: pos.currentValue,
                      shares: pos.shares,
                      apy: pos.apy,
                      fetchedAt: pos.fetchedAt,
                      isPriceUnavailable: pos.isPriceUnavailable,
                      priceStatus: pos.priceStatus,
                    });
                    const freshness = computeHoldingFreshness(pos.fetchedAt);
                    return (
                      <tr
                        key={i}
                        className="border-b border-white/5 hover:bg-white/5 transition-colors"
                        data-testid={`position-row-${pos.asset}`}
                      >
                        <td className="py-4 font-medium">{pos.protocol}</td>
                        <td className="py-4 text-gray-300">{pos.asset}</td>
                        <td className="py-4 text-right">
                          {formatCurrency(resolved.deposited)}
                        </td>
                        <td className="py-4 text-right font-medium">
                          {resolved.isUnpriced ? (
                            <span
                              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 font-medium"
                              data-testid="unpriced-holding-value"
                            >
                              Price unavailable
                            </span>
                          ) : resolved.isZeroBalance ? (
                            <span className="text-gray-400" data-testid="zero-holding-value">
                              $0.00
                            </span>
                          ) : (
                            <span data-testid="priced-holding-value">
                              {formatCurrency(resolved.currentValue!)}
                            </span>
                          )}
                        </td>
                        <td className="py-4 text-right text-[#3EAC75]">
                          {pos.apy}%
                        </td>
                        <td className="py-4 text-right font-medium">
                          {resolved.isUnpriced ? (
                            <span className="text-gray-500" data-testid="unpriced-holding-pnl">
                              —
                            </span>
                          ) : resolved.isZeroBalance ? (
                            <span className="text-gray-400" data-testid="zero-holding-pnl">
                              $0.00
                            </span>
                          ) : (
                            <span
                              className={
                                resolved.pnlUsd! >= 0 ? "text-[#3EAC75]" : "text-[#FF5E5E]"
                              }
                              data-testid="priced-holding-pnl"
                            >
                              {resolved.pnlUsd! >= 0 ? "+" : ""}
                              {formatCurrency(resolved.pnlUsd!)}
                            </span>
                          )}
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
      )}

      {/* Independently-fetching widgets: each manages its own loading,
          error, and retry state, and must render regardless of whether the
          position fetch above is pending, empty, or failed (issue #1151). */}
      <RiskScoreBreakdownPanel />

      {/* Allocation Presets */}
      <div className="glass-panel p-6">
        <PresetsPanel walletAddress={walletAddress} />
      </div>

      <UnifiedActivityTimeline walletAddress={walletAddress} />
    </div>
  );
}
