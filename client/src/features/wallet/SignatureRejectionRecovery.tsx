/**
 * SignatureRejectionRecovery (#1363)
 *
 * Shown when a wallet declines — or fails to complete — a signature request.
 * The copy comes from the shared typed rejection, never from the provider's raw
 * error string. Offers only the actions the classifier allows; after the
 * attempt limit, retry is removed and switching wallets is recommended.
 */

import { AlertTriangle, Plug, RefreshCw, Wallet, X } from "lucide-react";
import type { WalletSignatureRejection } from "../../../../shared/types/walletSignatureRejection";

export interface SignatureRejectionRecoveryProps {
  /** Human-readable action that was being signed, e.g. "portfolio deposit". */
  actionLabel: string;
  rejection: WalletSignatureRejection;
  isRetrying?: boolean;
  /** Progress for a partially completed batch, e.g. 1 of 2 vaults. */
  progress?: { completed: number; total: number };
  onRetry: () => void;
  onReconnect: () => void;
  onSwitchWallet: () => void;
  onCancel: () => void;
}

export default function SignatureRejectionRecovery({
  actionLabel,
  rejection,
  isRetrying = false,
  progress,
  onRetry,
  onReconnect,
  onSwitchWallet,
  onCancel,
}: SignatureRejectionRecoveryProps) {
  const { actions } = rejection;
  const partiallyCompleted = progress && progress.completed > 0;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="signature-rejection-recovery"
      className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
        <div className="flex-1">
          <p className="font-medium text-amber-200">{rejection.title}</p>
          <p className="text-xs text-amber-100/80 mt-0.5">{rejection.message}</p>
          <p className="text-xs text-amber-100/60 mt-1">{rejection.guidance}</p>

          {partiallyCompleted && (
            <p
              className="mt-2 text-xs text-amber-100/70"
              data-testid="signature-rejection-progress"
            >
              {progress.completed} of {progress.total} steps already completed;
              retrying resumes with the next unsigned step.
            </p>
          )}

          <p className="mt-2 text-[11px] uppercase tracking-wide text-amber-300/60">
            Attempt {rejection.attempt} of {rejection.maxAttempts}
            {rejection.remainingAttempts > 0
              ? ` · ${rejection.remainingAttempts} remaining`
              : " · attempt limit reached"}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {actions.includes("retry") && (
              <button
                type="button"
                onClick={onRetry}
                disabled={isRetrying}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-amber-100"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? "animate-spin" : ""}`} />
                {isRetrying ? "Waiting for wallet…" : `Retry ${actionLabel}`}
              </button>
            )}

            {actions.includes("reconnect") && (
              <button
                type="button"
                onClick={onReconnect}
                disabled={isRetrying}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-gray-100"
              >
                <Plug className="w-3.5 h-3.5" />
                Reconnect wallet
              </button>
            )}

            {actions.includes("switch_wallet") && (
              <button
                type="button"
                onClick={onSwitchWallet}
                disabled={isRetrying}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-gray-100"
              >
                <Wallet className="w-3.5 h-3.5" />
                Switch wallet
              </button>
            )}

            {actions.includes("cancel") && (
              <button
                type="button"
                onClick={onCancel}
                disabled={isRetrying}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium text-gray-400"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
