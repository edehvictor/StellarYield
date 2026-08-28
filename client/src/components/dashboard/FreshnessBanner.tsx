import React from "react";
import { Clock, AlertTriangle, CheckCircle, Info, RefreshCw } from "lucide-react";
import { computeDecayedFreshnessConfidence } from "./freshnessDecay";

interface FreshnessBannerProps {
  lastUpdated?: string;
  confidence?: number;
  isPartial?: boolean;
  isEstimated?: boolean;
  source?: "live" | "cache";
  onRefresh?: () => void;
}

export const FreshnessBanner: React.FC<FreshnessBannerProps> = ({
  lastUpdated,
  confidence,
  isPartial,
  isEstimated,
  source,
  onRefresh,
}) => {
  // If no lastUpdated, represent unknown / estimated state
  if (!lastUpdated && !source) {
    return (
      <div className="glass-panel border border-dashed border-gray-600/50 bg-gray-500/5 p-4 flex items-center justify-between gap-3 text-gray-400">
        <div className="flex items-center gap-2">
          <Info size={16} className="text-gray-400 shrink-0" />
          <span className="text-sm font-medium">
            {isEstimated
              ? "Estimated System Projections"
              : isPartial
              ? "Partial / Incomplete Yield Data"
              : "Unknown Freshness Status"}
          </span>
        </div>
        <span className="text-xs font-mono uppercase tracking-wider px-2 py-0.5 bg-white/5 rounded text-gray-400">
          Estimated / No Timestamp
        </span>
      </div>
    );
  }

  const parsedTime = lastUpdated ? new Date(lastUpdated) : null;
  const isInvalidDate = parsedTime ? Number.isNaN(parsedTime.getTime()) : false;

  if (isInvalidDate) {
    return (
      <div className="glass-panel border border-red-500/30 bg-red-500/10 p-4 flex items-center gap-2 text-red-400">
        <AlertTriangle size={16} className="shrink-0" />
        <span className="text-sm">Invalid timestamp provided for data freshness check.</span>
      </div>
    );
  }

  // Cache source banner
  if (source === "cache") {
    const ageMs = parsedTime ? Date.now() - parsedTime.getTime() : 0;
    const calculated = parsedTime ? computeDecayedFreshnessConfidence(ageMs) : { confidence: 0, unusable: true };
    const finalConfidence = confidence !== undefined ? confidence : calculated.confidence;
    const isStale = finalConfidence < 0.5 || calculated.unusable;

    return (
      <div
        className={`glass-panel border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
          isStale
            ? "border-purple-500/30 bg-purple-500/10 text-purple-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-200"
        }`}
        role="status"
      >
        <div className="flex items-start sm:items-center gap-2.5">
          <Clock size={18} className="shrink-0 mt-0.5 sm:mt-0 text-amber-400" />
          <div>
            <p className="text-sm font-semibold">
              {isStale ? "Stale Cached Data" : "Showing Cached Data"}
            </p>
            <p className="text-xs opacity-80 mt-0.5">
              {parsedTime
                ? `Cached: ${parsedTime.toLocaleTimeString()} (${Math.max(0, Math.round(ageMs / 60000))}m ago) · Confidence: ${Math.round(finalConfidence * 100)}%`
                : "No timestamp available"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <span
            className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full ${
              isStale
                ? "bg-purple-500/25 border border-purple-500/40 text-purple-300"
                : "bg-amber-500/25 border border-amber-500/40 text-amber-300"
            }`}
          >
            {isStale ? "Stale Cache" : "Cached"}
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="btn-secondary inline-flex items-center gap-1.5 text-xs px-3 py-1.5"
              aria-label="Refresh data from live API"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!parsedTime) {
    return null;
  }

  const ageMs = Date.now() - parsedTime.getTime();
  const calculated = computeDecayedFreshnessConfidence(ageMs);
  const finalConfidence = confidence !== undefined ? confidence : calculated.confidence;
  const isStale = finalConfidence < 0.5 || calculated.unusable;

  return (
    <div
      className={`glass-panel border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
        isStale
          ? "border-red-500/30 bg-red-500/10 text-red-300"
          : finalConfidence < 0.8
          ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-300"
          : "border-green-500/30 bg-green-500/10 text-green-300"
      }`}
      role="status"
    >
      <div className="flex items-start sm:items-center gap-2.5">
        {isStale ? (
          <AlertTriangle size={18} className="shrink-0 mt-0.5 sm:mt-0 text-red-400" />
        ) : finalConfidence < 0.8 ? (
          <Info size={18} className="shrink-0 mt-0.5 sm:mt-0 text-yellow-400" />
        ) : (
          <CheckCircle size={18} className="shrink-0 mt-0.5 sm:mt-0 text-green-400" />
        )}
        <div>
          <p className="text-sm font-semibold">
            {isStale
              ? "Stale DeFi Market Data"
              : isPartial
              ? "Partial Live Data Stream"
              : isEstimated
              ? "Estimated System Projections"
              : "Live Market Sync Active"}
          </p>
          <p className="text-xs opacity-80 mt-0.5">
            Synced: {parsedTime.toLocaleTimeString()} ({Math.max(0, Math.round(ageMs / 60000))}m ago) · Confidence score:{" "}
            {Math.round(finalConfidence * 100)}%
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        <span
          className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full self-start sm:self-auto ${
            isStale
              ? "bg-red-500/25 border border-red-500/40 text-red-300"
              : finalConfidence < 0.8
              ? "bg-yellow-500/25 border border-yellow-500/40 text-yellow-300"
              : "bg-green-500/25 border border-green-500/40 text-green-300"
          }`}
        >
          {isStale ? "Stale" : finalConfidence < 0.8 ? "Decayed" : "Fresh"}
        </span>
        {onRefresh && (source as string) !== "cache" && (
          <button
            onClick={onRefresh}
            className="btn-secondary inline-flex items-center gap-1.5 text-xs px-3 py-1.5"
            aria-label="Force refresh data"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        )}
      </div>
    </div>
  );
};
