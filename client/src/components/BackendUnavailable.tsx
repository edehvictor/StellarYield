import React from "react";
import { AlertCircle, WifiOff, RefreshCw, Activity } from "lucide-react";
import { openDiagnosticsPanel } from "../lib/config";

export interface BackendUnavailableProps {
  featureName: string;
  reason?: string;
  onRetry?: () => void;
  compact?: boolean;
}

/**
 * Component to display when backend API is unavailable.
 * Provides user-friendly messaging and optional retry functionality.
 */
export function BackendUnavailable({
  featureName,
  reason,
  onRetry,
  compact = false,
}: BackendUnavailableProps) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded bg-amber-500/10 border border-amber-500/30">
        <WifiOff size={16} className="text-amber-500 flex-shrink-0" />
        <span className="text-sm text-amber-200">{featureName} unavailable</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="ml-auto p-1 hover:bg-amber-500/20 rounded transition-colors text-amber-300"
            title="Retry"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-panel p-12 border border-amber-500/30 bg-amber-500/5 rounded-lg">
        <div className="flex flex-col items-center text-center gap-4">
          <div className="rounded-full bg-amber-500/20 p-4">
            <AlertCircle size={32} className="text-amber-500" />
          </div>

          <div className="space-y-2">
            <h3 className="text-xl font-bold text-white">
              {featureName} Temporarily Unavailable
            </h3>
            <p className="text-gray-400 max-w-sm">
              {reason ||
                "The backend service is not currently available. Please try again in a moment."}
            </p>
          </div>

          <div className="mt-4 flex items-center gap-3 flex-wrap justify-center">
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-medium transition-colors"
              >
                <RefreshCw size={16} />
                Try Again
              </button>
            )}
            <button
              type="button"
              onClick={() => openDiagnosticsPanel()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition-colors border border-slate-700"
            >
              <Activity size={15} className="text-indigo-400" />
              Check Diagnostics
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact alert for embedding in smaller UI elements
 */
export function BackendUnavailableAlert({
  message = "Backend service unavailable",
  onDismiss,
}: {
  message?: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 flex items-start gap-3">
      <WifiOff size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
      <p className="text-sm text-amber-200 flex-1">{message}</p>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-amber-500 hover:text-amber-400 font-bold"
        >
          ✕
        </button>
      )}
    </div>
  );
}
