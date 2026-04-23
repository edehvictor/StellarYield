/**
 * Yield Strategy Backtester UI
 * Interactive charting with historical equity curve and APY overlay
 */

import { useState, useCallback, useMemo } from "react";
import { Calendar, TrendingUp, AlertCircle, Loader2 } from "lucide-react";
import type { BacktestRequest, BacktestResult } from "./types";
import { fetchBacktestData, calculateTotalReturn } from "./backtestService";

export interface BacktestPanelProps {
  vaultContractId: string;
  vaultName: string;
}

export default function BacktestPanel({
  vaultContractId,
  vaultName,
}: BacktestPanelProps) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleRunBacktest = useCallback(async () => {
    if (!startDate || !endDate || !depositAmount) {
      setError("Please fill in all fields");
      return;
    }

    if (new Date(startDate) >= new Date(endDate)) {
      setError("Start date must be before end date");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const request: BacktestRequest = {
        vaultContractId,
        startDate,
        endDate,
        depositAmount: BigInt(depositAmount),
      };

      const data = await fetchBacktestData(request);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, depositAmount, vaultContractId]);

  const totalReturn = useMemo(() => {
    if (!result) return 0;
    return calculateTotalReturn(result.initialDeposit, result.finalValue);
  }, [result]);

  const maxEquity = useMemo(() => {
    if (!result?.snapshots.length) return 0n;
    return result.snapshots.reduce(
      (max, s) => (s.equityValue > max ? s.equityValue : max),
      0n,
    );
  }, [result]);

  return (
    <div className="space-y-6">
      {/* Input Form */}
      <div className="glass-panel p-6 space-y-4">
        <h2 className="text-xl font-semibold">Backtest {vaultName}</h2>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Deposit Amount (USDC)
            </label>
            <input
              type="number"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <AlertCircle className="w-5 h-5 text-red-500" />
            <span className="text-sm text-red-400">{error}</span>
          </div>
        )}

        <button
          onClick={handleRunBacktest}
          disabled={loading}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Running Backtest...
            </>
          ) : (
            <>
              <TrendingUp className="w-5 h-5" />
              Run Backtest
            </>
          )}
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Summary Cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="glass-panel p-4">
              <p className="text-sm text-gray-400">Initial Deposit</p>
              <p className="text-2xl font-bold text-white">
                {result.initialDeposit.toString()}
              </p>
              <p className="text-xs text-gray-500">USDC</p>
            </div>
            <div className="glass-panel p-4">
              <p className="text-sm text-gray-400">Final Value</p>
              <p className="text-2xl font-bold text-white">
                {result.finalValue.toString()}
              </p>
              <p className="text-xs text-gray-500">USDC</p>
            </div>
            <div
              className={`glass-panel p-4 ${totalReturn >= 0 ? "border-green-500/30" : "border-red-500/30"}`}
            >
              <p className="text-sm text-gray-400">Total Return</p>
              <p
                className={`text-2xl font-bold ${totalReturn >= 0 ? "text-green-400" : "text-red-400"}`}
              >
                {totalReturn.toFixed(2)}%
              </p>
              <p className="text-xs text-gray-500">
                {totalReturn >= 0 ? "+" : ""}
                {(result.finalValue - result.initialDeposit).toString()} USDC
              </p>
            </div>
          </div>

          {/* Chart Placeholder */}
          <div className="glass-panel p-6">
            <h3 className="text-lg font-semibold mb-4">Equity Curve</h3>
            <div className="h-64 bg-black/30 rounded-lg flex items-center justify-center">
              <div className="text-center">
                <p className="text-gray-400 mb-2">Chart visualization</p>
                <p className="text-xs text-gray-500">
                  {result.snapshots.length} daily snapshots from{" "}
                  {result.startDate} to {result.endDate}
                </p>
              </div>
            </div>
          </div>

          {/* APY Timeline */}
          <div className="glass-panel p-6">
            <h3 className="text-lg font-semibold mb-4">APY History</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {result.snapshots.slice(-10).map((snapshot) => (
                <div
                  key={snapshot.date}
                  className="flex justify-between text-sm p-2 bg-black/30 rounded"
                >
                  <span className="text-gray-400">{snapshot.date}</span>
                  <span className="font-medium">
                    {snapshot.apy.toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
