import React, { useEffect, useCallback, useMemo } from "react";
import {
  X,
  ArrowRight,
  Shield,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Wallet,
} from "lucide";
import { QuoteAssumptionFingerprintDisplay } from "./QuoteAssumptionFingerprintDisplay";
import type { QuoteAssumptions } from "../../../../shared/types/quoteAssumptionFingerprint";

export interface TransactionReviewTokenDetail {
  symbol: string;
  amount: string;
  contractId?: string;
  decimals?: number;
}

/**
 * Explicit context that a quote / transaction was computed against.
 * Reads and writes are bound to this context and musmatches are rejected.
 */
export interface TransactionExecutionContext {
  network?: string;
  ledger?: number | string;
  version?: string;
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
  /** Context the quote was computed against (read). */
  expectedContext?: TransactionExecutionContext | null;
  /** Currently active context of the client / ledger (write). */
  currentContext?: TransactionExecutionContext | null;
  /** Optional override for the context mismatch message. */
  contextMismatchMessage?: string;
}

export type TransactionContextMismatchReason =
  | "network"
  | "ledger"
  | "version";

export interface TransactionContextMismatch {
  reason: TransactionContextMismatchReason;
  expected: string;
  actual: string;
}

function normalizeContextValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const asString = String(value).trim();
  if (asString.length === 0) return null;
  return asString;
}

/**
 * Compare the context the quote was read against with the currently active
 * context that would be written to. Returns the first mismatch, rejecting
 * any context field that is present on one side but not the other.
 */
export function detectTransactionContextMismatch(
  expected: TransactionExecutionContext | null | undefined,
  current: TransactionExecutionContext | null | undefined,
): TransactionContextMismatch | null {
  if (!expected || !current) return null;

  const fields: Array<[TransactionContextMismatchReason, keyof TransactionExecutionContext]> = [
    ["network", "network"],
    ["ledger", "ledger"],
    ["version", "version"],
  ];

  for (const [reason, key] of fields) {
    const expectedValue = normalizeContextValue(expected[key]);
    const currentValue = normalizeContextValue(current[key]);

    // Both sides absent: this dimension is not being enforced.
    if (expectedValue === null && currentValue === null) continue;

    // One side present, the other absent: treat as a mismatch rather than
    // silently falling through to a write against an unbound context.
    if (expectedValue === null || currentValue === null) {
      return {
        reason,
        expected: expectedValue ?? "unknown",
        actual: currentValue ?? "unknown",
      };
    }

    if (expectedValue !== currentValue) {
      return { reason, expected: expectedValue, actual: currentValue };
    }
  }

  return null;
}

function formatMismatchMessage(mismatch: TransactionContextMismatch): string {
  const label =
    mismatch.reason === "network"
      ? "Network"
      : mismatch.reason === "ledger"
        ? "Ledger"
        : "Protocol version";
  return `${label} changed since this quote was issued (expected ${mismatch.expected}, now ${mismatch.actual}).`
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
  expectedContext = null,
  currentContext = null,
  contextMismatchMessage,
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

  const contextMismatch = useMemo(
    () => detectTransactionContextMismatch(expectedContext, currentContext),
    [expectedContext, currentContext],
  );

  if (!isOpen) return null;

  const effectiveError =
    error ??
    (contextMismatch
      ? contextMismatchMessage ?? formatMismatchMessage(contextMismatch)
      : null);

  const canConfirm = !isSubmitting && !isStale && !effectiveError && !contextMismatch;

  const handleConfirm = useCallback(() => {
    // Reject writes that would land against a different network, ledger,
    // or version than the one the quote was read against. This keeps the
    // existing state and balances intact on failure.
    if (!canConfirm) return;
    void onConfirm();
  }, [canConfirm, onConfirm]);

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

          {/* Explicit execution context binding */}
          {(expectedContext || currentContext) && (
            <div
              data-testid="transaction-context"
              className="rounded-xl bg-white/5 p-3 text-xs space-y-1"
            >
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Execution Context</span>
                <span className="font-mono text-gray-200">
                  {currentContext?.network ?? expectedContext?.network ?? "unknown"}
                  {currentContext?.ledger != null
                    ? ` ? ledger ${currentContext.ledger}`
                    : ""}
                  {currentContext?.version ? ` / v${currentContext.version}` : ""}
                </span>
              </div>
              {contextMismatch && (
                <p className="text-red-300">
                  Quote was issued against a different context. Refresh the quote before signing.
                </p>
              )}
            </div>
          )}

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
          {effectiveError && (
            <div
              className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200"
              role="alert"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
              <div>
                <p className="font-semibold text-red-300">Submission blocked</p>
                <p>{effectiveError}</p>
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
            onClick={handleConfirm}
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
