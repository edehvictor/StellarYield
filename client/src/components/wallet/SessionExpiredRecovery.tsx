import { AlertTriangle, RefreshCw, X, Plug } from "lucide-react";

/**
 * Issue #1152 — recovery banner shown when a protected wallet action (quote
 * preview, transaction submission) was blocked because the wallet session
 * had expired. Offers reconnect (resumes the original action on success),
 * cancel (discards it), or retry (re-checks the session without a fresh
 * connect flow, e.g. after the user reconnected from elsewhere).
 */

export interface SessionExpiredRecoveryProps {
  /** Short label for what the user was trying to do, e.g. "Zap deposit". */
  actionLabel: string;
  onReconnect: () => void;
  onCancel: () => void;
  onRetry: () => void;
  isReconnecting?: boolean;
}

export default function SessionExpiredRecovery({
  actionLabel,
  onReconnect,
  onCancel,
  onRetry,
  isReconnecting = false,
}: SessionExpiredRecoveryProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="session-expired-recovery"
      className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
        <div className="flex-1">
          <p className="font-medium text-amber-300">Wallet session expired</p>
          <p className="text-xs text-amber-200/70 mt-0.5">
            Your wallet session expired before "{actionLabel}" could complete.
            Reconnect to pick up right where you left off.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onReconnect}
              disabled={isReconnecting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-amber-200"
            >
              <Plug className={`w-3.5 h-3.5 ${isReconnecting ? "animate-pulse" : ""}`} />
              {isReconnecting ? "Reconnecting…" : "Reconnect & resume"}
            </button>
            <button
              type="button"
              onClick={onRetry}
              disabled={isReconnecting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-gray-200"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isReconnecting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-gray-400"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
