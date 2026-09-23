import React, { useMemo } from "react";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import type { DailyMovement, AssetMovement, ProtocolMovement } from "../../../shared/types/dailyMovement";

interface DailyMovementPanelProps {
  movement: DailyMovement;
  compact?: boolean;
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function MovementBadge({ movement, isNegative }: { movement: number; isNegative: boolean }) {
  if (movement === 0) {
    return (
      <div className="flex items-center gap-1 px-3 py-1 rounded-lg bg-gray-500/20 text-gray-400">
        <Minus className="w-4 h-4" />
        <span className="text-sm font-semibold">No change</span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 px-3 py-1 rounded-lg font-semibold text-sm ${
        isNegative
          ? "bg-red-500/20 text-red-400"
          : "bg-green-500/20 text-green-400"
      }`}
    >
      {isNegative ? (
        <ArrowDownRight className="w-4 h-4" />
      ) : (
        <ArrowUpRight className="w-4 h-4" />
      )}
      {Math.abs(movement).toFixed(2)}%
    </div>
  );
}

function AssetMovementRow({ asset }: { asset: AssetMovement }) {
  const isNegative = asset.absoluteChange < 0;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-800/30 transition">
      <div className="flex-1">
        <div className="font-medium text-gray-100">{asset.asset}</div>
        <div className="text-xs text-gray-500">
          {asset.previousQuantity.toLocaleString()} → {asset.currentQuantity.toLocaleString()} units
        </div>
      </div>
      <div className="text-right flex items-center gap-3">
        <div>
          <div className={`font-semibold ${isNegative ? "text-red-400" : "text-green-400"}`}>
            {formatUsd(asset.absoluteChange)}
          </div>
          <div className="text-xs text-gray-500">{formatPercent(asset.percentChange)}</div>
        </div>
        <MovementBadge movement={asset.percentChange} isNegative={isNegative} />
      </div>
    </div>
  );
}

function ProtocolMovementRow({ protocol }: { protocol: ProtocolMovement }) {
  const isNegative = protocol.absoluteChange < 0;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-800/30 transition">
      <div className="font-medium text-gray-100">{protocol.protocol}</div>
      <div className="text-right flex items-center gap-3">
        <div>
          <div className={`font-semibold ${isNegative ? "text-red-400" : "text-green-400"}`}>
            {formatUsd(protocol.absoluteChange)}
          </div>
          <div className="text-xs text-gray-500">{formatPercent(protocol.percentChange)}</div>
        </div>
        <MovementBadge movement={protocol.percentChange} isNegative={isNegative} />
      </div>
    </div>
  );
}

export const DailyMovementPanel: React.FC<DailyMovementPanelProps> = ({ movement, compact }) => {
  const { topAsset, topProtocol } = useMemo(() => {
    return {
      topAsset: movement.assetMovements[0],
      topProtocol: movement.protocolMovements[0],
    };
  }, [movement]);

  // If no previous snapshot, show neutral state
  if (!movement.hasPreviousSnapshot) {
    return (
      <div className="glass-panel p-6 border border-gray-700">
        <h3 className="text-lg font-bold mb-4 text-gray-300">Daily Portfolio Movement</h3>
        <div className="flex items-center justify-center py-8 text-gray-500">
          <p>No previous snapshot available for comparison.</p>
        </div>
      </div>
    );
  }

  const isNegative = movement.isNegativeMovement;

  if (compact) {
    return (
      <div className="glass-panel p-4 border border-gray-700 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-gray-200">Daily Change</h4>
          <MovementBadge movement={movement.totalPercentChange} isNegative={isNegative} />
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-gray-500 text-xs">Portfolio Value</div>
            <div className={`font-semibold ${isNegative ? "text-red-400" : "text-green-400"}`}>
              {formatUsd(movement.totalAbsoluteChange)}
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-xs">Price Movement</div>
            <div className={`font-semibold ${movement.priceMovementOnly < 0 ? "text-red-400" : "text-green-400"}`}>
              {formatUsd(movement.priceMovementOnly)}
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-xs">Net Activity</div>
            <div className={`font-semibold ${(movement.depositedToday - movement.withdrawnToday) > 0 ? "text-green-400" : "text-red-400"}`}>
              {formatUsd(movement.depositedToday - movement.withdrawnToday)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-6 border border-gray-700 space-y-6">
      {/* Header with overall movement */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-100">Daily Portfolio Movement</h3>
          <p className="text-sm text-gray-500 mt-1">
            Compared to {movement.previousSnapshotDate || "previous day"}
          </p>
        </div>
        <div className="text-right">
          <div className={`text-3xl font-bold ${isNegative ? "text-red-400" : "text-green-400"}`}>
            {formatUsd(movement.totalAbsoluteChange)}
          </div>
          <div className="flex items-center justify-end gap-2 mt-1">
            <MovementBadge movement={movement.totalPercentChange} isNegative={isNegative} />
          </div>
        </div>
      </div>

      {/* Movement breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Price Movement */}
        <div className="bg-gray-800/20 rounded-lg p-4 border border-gray-700/50">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Price Movement</div>
          <div className={`text-2xl font-bold ${movement.priceMovementOnly < 0 ? "text-red-400" : "text-green-400"}`}>
            {formatUsd(movement.priceMovementOnly)}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Portfolio value change from price swings alone
          </p>
        </div>

        {/* Deposits */}
        <div className="bg-gray-800/20 rounded-lg p-4 border border-gray-700/50">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Deposits</div>
          <div className="text-2xl font-bold text-blue-400">
            {formatUsd(movement.depositedToday)}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            New funds added today
          </p>
        </div>

        {/* Withdrawals */}
        <div className="bg-gray-800/20 rounded-lg p-4 border border-gray-700/50">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Withdrawals</div>
          <div className="text-2xl font-bold text-orange-400">
            {formatUsd(movement.withdrawnToday)}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Funds withdrawn today
          </p>
        </div>
      </div>

      {/* Asset Movements */}
      {movement.assetMovements.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-semibold text-gray-100 text-sm">Asset Performance</h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {movement.assetMovements.map((asset) => (
              <AssetMovementRow key={asset.asset} asset={asset} />
            ))}
          </div>
        </div>
      )}

      {/* Protocol Movements */}
      {movement.protocolMovements.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-semibold text-gray-100 text-sm">Protocol Allocation Changes</h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {movement.protocolMovements.map((protocol) => (
              <ProtocolMovementRow key={protocol.protocol} protocol={protocol} />
            ))}
          </div>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-700">
        <div>
          <div className="text-xs text-gray-500 mb-1">Previous Total Value</div>
          <div className="text-lg font-semibold text-gray-100">
            {formatUsd(movement.previousTotalValue)}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">Current Total Value</div>
          <div className="text-lg font-semibold text-gray-100">
            {formatUsd(movement.currentTotalValue)}
          </div>
        </div>
      </div>
    </div>
  );
};
