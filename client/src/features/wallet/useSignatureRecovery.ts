/**
 * Recovery state for rejected wallet signatures (#1363).
 *
 * Wraps the typed classifier with attempt tracking and a retry that reruns the
 * caller's action. The action owns the actual work (including resuming after a
 * partially completed batch); the hook owns the recovery state and telemetry.
 */

import { useCallback, useRef, useState } from "react";
import {
  classifyWalletSignatureError,
  DEFAULT_MAX_SIGNATURE_ATTEMPTS,
  isWalletSignatureRejection,
  type WalletSignatureRejection,
} from "../../../../shared/types/walletSignatureRejection";
import { reportSignatureRejection } from "./signatureRejectionApi";

export interface UseSignatureRecoveryOptions {
  /** Stable action id used in telemetry, e.g. `portfolio_deposit`. */
  action: string;
  /** Wallet provider id, when known. */
  provider?: string | null;
  walletAddress?: string | null;
  maxAttempts?: number;
  /** Re-run the failed action. Must throw/report failures back through `fail`. */
  onRetry: () => Promise<void> | void;
  /** Reports progress for a multi-step action (best-effort telemetry). */
  getProgress?: () => { completed: number; total: number };
}

export interface SignatureRecoveryController {
  /** Current rejection, or null when the flow has not failed. */
  rejection: WalletSignatureRejection | null;
  attempts: number;
  isRetrying: boolean;
  /**
   * Record a signing failure. Returns the typed rejection, or null when the
   * error is not a wallet signature failure (callers show their normal error).
   */
  fail: (error: unknown) => WalletSignatureRejection | null;
  /** Retry the failed action when the rejection permits it. */
  retry: () => Promise<void>;
  /** Dismiss the recovery panel and reset the attempt counter. */
  dismiss: () => void;
  /** Clear the flow after a successful retry. */
  reset: () => void;
}

export function useSignatureRecovery({
  action,
  provider,
  walletAddress,
  maxAttempts = DEFAULT_MAX_SIGNATURE_ATTEMPTS,
  onRetry,
  getProgress,
}: UseSignatureRecoveryOptions): SignatureRecoveryController {
  const [rejection, setRejection] = useState<WalletSignatureRejection | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const attemptsRef = useRef(0);

  const reset = useCallback(() => {
    attemptsRef.current = 0;
    setAttempts(0);
    setRejection(null);
    setIsRetrying(false);
  }, []);

  const fail = useCallback(
    (error: unknown): WalletSignatureRejection | null => {
      if (!isWalletSignatureRejection(error)) return null;

      const nextAttempt = attemptsRef.current + 1;
      const classified = classifyWalletSignatureError(error, {
        attempt: nextAttempt,
        maxAttempts,
        provider: provider ?? undefined,
      });

      attemptsRef.current = classified.attempt;
      setAttempts(classified.attempt);
      setRejection(classified);

      const progress = getProgress?.();
      void reportSignatureRejection({
        action,
        rejection: classified,
        walletAddress,
        completedSteps: progress?.completed,
        totalSteps: progress?.total,
      });

      return classified;
    },
    [action, getProgress, maxAttempts, provider, walletAddress],
  );

  const retry = useCallback(async () => {
    if (!rejection?.retryable || isRetrying) return;

    setIsRetrying(true);
    try {
      await onRetry();
    } catch {
      // The action reports failures through `fail`; never let a rejected
      // promise escape an onClick handler.
    } finally {
      setIsRetrying(false);
    }
  }, [isRetrying, onRetry, rejection]);

  const dismiss = useCallback(() => {
    reset();
  }, [reset]);

  return {
    rejection,
    attempts,
    isRetrying,
    fail,
    retry,
    dismiss,
    reset,
  };
}
