import React, { useEffect, useCallback } from "react";
import {
  X,
  ArrowRight,
  Shield,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Wallet,
} from "lucide-react";
import { QuoteAssumptionFingerprintDisplay } from "./QuoteAssumptionFingerprintDisplay";
import type { QuoteAssumptions } from "../../../../shared/types/quoteAssumptionFingerprint";

export interface TransactionReviewTokenDetail {
  symbol: string;
  amount: string;
  contractId?: string;
  decimals?: number;
}

export interface TransactionReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  isSubmitting?: boolean;
  actionTitle?: string;
  walletAddress: string;
  inputToken: TransactionReviewTokenDetail;
  vaultToken: TransactionReviewTokenDetail & { minAmount?: string };
  slippageTolerance: number;
  assumptions?: QuoteAssumptions | null;
  fingerprint?: string;
  isStale?: boolean;
  onRefreshQuote?: () => void;
  error?: string | null;
}

export function TransactionReviewModal({
  isOpen,
  onClose,
  onConfirm,
  isSubmitting = false,
  actionTitle = "Review Transaction",
  walletAddress,
  inputToken,
  vaultToken,
  slippageTolerance,
  assumptions,
  fingerprint,
  isStale = false,
  onRefreshQuote,
  error = null,
}: TransactionReviewModalProps) {
  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) {
        onClose();
      }
    },
    [onClose, isSubmitting],
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const canConfirm = !isSubmitting && !isStale && !error;

  return (
    <div
      data-testid="transaction-review-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-modal-title"
    >
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0F172A] p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h2 id="review-modal-title" className="text-base font-bold text-white">
                {actionTitle}
              </h2>
              <p className="text-xs text-gray-400">Verify parameters and quote cryptographic fingerprint</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
            aria-label="Close review dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="mt-4 space-y-4">
          {/* Wallet and Network Info */}
          <div className="flex items-center justify-between rounded-xl bg-white/5 p-3 text-xs">
            <span className="text-gray-400 flex items-center gap-1.5">
              <Wallet className="h-3.5 w-3.5 text-gray-400" />
              Connected Account
            </span>
            <span className="font-mono text-gray-200">
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
            </span>
          </div>

          {/* Tokens and Amount Exchange Card */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs text-gray-400 block">You Deposit</span>
                <span className="text-lg font-bold text-white">
                  {inputToken.amount} {inputToken.symbol}
                </span>
              </div>
              <ArrowRight className="h-5 w-5 text-gray-500" />
              <div className="text-right">
                <span className="text-xs text-gray-400 block">Estimated Output</span>
                <span className="text-lg font-bold text-white">
                  {vaultToken.amount} {vaultToken.symbol}
                </span>
              </div>
            </div>

            {vaultToken.minAmount && (
              <div className="flex items-center justify-between pt-2 border-t border-white/10 text-xs">
                <span className="text-gray-400">Guaranteed Minimum ({slippageTolerance}% slippage)</span>
                <span className="font-mono text-emerald-300">
                  {vaultToken.minAmount} {vaultToken.symbol}
                </span>
              </div>
            )}
          </div>

          {/* Embedded Cryptographic Quote Assumption Fingerprint */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-gray-300">Cryptographic Verification</span>
            <QuoteAssumptionFingerprintDisplay
              assumptions={assumptions}
              fingerprint={fingerprint}
              isStale={isStale}
              onRefresh={onRefreshQuote}
              initialExpanded={false}
            />
          </div>

          {/* Error Message if Present */}
          {error && (
            <div
              className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200"
              role="alert"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
              <div>
                <p className="font-semibold text-red-300">Submission blocked</p>
                <p>{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Action Buttons */}
        <div className="mt-6 flex items-center justify-end gap-3 pt-4 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
            data-testid="confirm-transaction-btn"
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg hover:from-blue-600 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Signing…
              </>
            ) : (
              "Confirm & Sign"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TransactionReviewModal;
