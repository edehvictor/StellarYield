import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpFromLine,
  Clock,
  Info,
  Loader2,
} from "lucide-react";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import TransactionFailedModal from "../../components/transaction/TransactionFailedModal";
import { decodeTransactionError } from "../../utils/errorDecoder";
import { withdraw, getUserShares } from "../../services/soroban";
import {
  TX_PHASE_PIPELINE,
  type TxPhase,
} from "../../services/transactionPhase";
import { parseDecimalToStroops, formatStroopsToDecimal } from "../zap/amount";
import { getVaultTokenFromEnv } from "../zap/assets";
import { apiFetch, getApiBaseUrlOrNull } from "../../lib/api";
import { useParams } from "react-router-dom";
import {
  WITHDRAW_QUOTE_TTL_MS,
  isWithdrawQuoteStale,
  withdrawQuoteAgeSeconds,
} from "./withdrawQuoteFreshness";
import { useProtectedWalletAction } from "../../hooks/useProtectedWalletAction";
import SessionExpiredRecovery from "../../components/wallet/SessionExpiredRecovery";

export interface WithdrawPanelProps {
  walletAddress: string | null;
}

// ── Withdrawal preview types ────────────────────────────────────────────────

interface ReserveImpactPreview {
  currentReserveRatioPct: number;
  projectedReserveRatioPct: number;
  projectedReserveUsd: number;
  breachesMinBuffer: boolean;
  minBufferPct: number;
}

interface WithdrawalPreview {
  vaultId: string;
  requestedAmountUsd: number;
  exitFeeUsd: number;
  exitFeeBps: number;
  processingDelayLabel: string;
  processingDelaySeconds: number;
  estimatedNetUsd: number;
  optimisticNetUsd: number;
  conservativeNetUsd: number;
  priceImpactPct: number;
  isLowLiquidity: boolean;
  quotedAt: string;
  expiresAt?: string;
  quoteTtlMs?: number;
  reserveImpact?: ReserveImpactPreview;
}

// Fallback USD rate — in production this would come from a price oracle.
const STROOPS_PER_UNIT = 1e7;
const ESTIMATED_ASSET_USD_PRICE = 1.0; // treat vault tokens as $1 USDC equivalent

function stroopsToUsd(stroops: bigint, decimals: number): number {
  const units = Number(stroops) / 10 ** decimals;
  return units * ESTIMATED_ASSET_USD_PRICE;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

// ── Preview panel sub-component ────────────────────────────────────────────

interface PreviewPanelProps {
  preview: WithdrawalPreview | null;
  loading: boolean;
  error: string | null;
  isStale: boolean;
  quoteAgeSecs: number | null;
  onRefresh: () => void;
}

function PreviewPanel({
  preview,
  loading,
  error,
  isStale,
  quoteAgeSecs,
  onRefresh,
}: PreviewPanelProps) {
  if (loading) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading withdrawal preview"
        className="flex items-center gap-2 py-3 text-sm text-gray-400"
      >
        <Loader2 className="w-4 h-4 animate-spin" />
        Calculating preview…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-300"
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Preview unavailable: {error}. Review carefully before submitting.
        </span>
      </div>
    );
  }

  if (!preview) return null;

  return (
    <div
      role="region"
      aria-label="Withdrawal preview"
      className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3 text-sm"
    >
      <h4 className="font-semibold text-white flex items-center gap-2">
        <Info className="w-4 h-4 text-indigo-400" />
        Withdrawal Preview
        {quoteAgeSecs !== null && (
          <span
            data-testid="withdraw-quote-age"
            className="ml-auto flex items-center gap-1 text-xs font-normal text-gray-400"
          >
            <Clock className="w-3 h-3" />
            {quoteAgeSecs}s ago
          </span>
        )}
      </h4>

      {/* Stale quote warning (#1308) — blocks submission until refreshed */}
      {isStale && (
        <div
          role="alert"
          data-testid="withdraw-stale-warning"
          className="flex items-start gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-xs text-yellow-200/80"
        >
          <Clock className="w-4 h-4 shrink-0 text-yellow-400 mt-0.5" />
          <span className="flex-1">
            Stale quote — this estimate is over{" "}
            {Math.round(WITHDRAW_QUOTE_TTL_MS / 1000)} seconds old and may no
            longer reflect pool liquidity or fees. Refresh before submitting.
          </span>
          <button
            type="button"
            onClick={onRefresh}
            data-testid="withdraw-refresh-quote"
            className="shrink-0 rounded-md border border-yellow-500/40 px-2 py-1 text-yellow-200 hover:bg-yellow-500/20"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Net output row */}
      <div className="flex items-center justify-between">
        <span className="text-gray-400">Estimated received</span>
        <span className="font-semibold text-white">
          {formatUsd(preview.estimatedNetUsd)}
        </span>
      </div>

      {/* Fee row */}
      <div className="flex items-center justify-between">
        <span className="text-gray-400">
          Exit fee ({preview.exitFeeBps / 100}%)
        </span>
        <span className="text-red-400">−{formatUsd(preview.exitFeeUsd)}</span>
      </div>

      {/* Price impact row */}
      <div className="flex items-center justify-between">
        <span className="text-gray-400">Price impact</span>
        <span
          className={
            preview.priceImpactPct > 2 ? "text-red-400" : "text-green-400"
          }
        >
          {preview.priceImpactPct.toFixed(3)}%
        </span>
      </div>

      {/* Processing delay */}
      <div className="flex items-center justify-between">
        <span className="text-gray-400 flex items-center gap-1">
          <Clock className="w-3.5 h-3.5" /> Settlement
        </span>
        <span className="text-gray-300">{preview.processingDelayLabel}</span>
      </div>

      {/* Optimistic / conservative range */}
      <div className="rounded-lg bg-black/20 p-3 space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-gray-400">Optimistic</span>
          <span className="text-green-400 font-medium">
            {formatUsd(preview.optimisticNetUsd)}
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-gray-400">Conservative</span>
          <span className="text-orange-400 font-medium">
            {formatUsd(preview.conservativeNetUsd)}
          </span>
        </div>
      </div>

      {/* Low-liquidity warning */}
      {preview.isLowLiquidity && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-xs text-yellow-200/80"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 text-yellow-400 mt-0.5" />
          Low liquidity detected. Consider withdrawing in smaller batches to
          reduce price impact.
        </div>
      )}

      {/* Low-reserve warning */}
      {preview.reserveImpact?.breachesMinBuffer && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-200/80"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
          <span>
            <span className="font-medium text-amber-100">Low reserve detected.</span>{" "}
            This withdrawal would leave the vault below its minimum reserve
            buffer. Projected reserve ratio: {preview.reserveImpact.projectedReserveRatioPct.toFixed(1)}% vs {preview.reserveImpact.minBufferPct}% minimum.
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function WithdrawPanel({ walletAddress }: WithdrawPanelProps) {
  const vaultToken = getVaultTokenFromEnv();
  const { slug: vaultSlug } = useParams<{ slug?: string }>();
  const vaultId = vaultSlug ?? "usdc";

  const [shareBalance, setShareBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const [lastProgressPhase, setLastProgressPhase] = useState<TxPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showFailedModal, setShowFailedModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Preview state
  const [preview, setPreview] = useState<WithdrawalPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stale-quote clock (#1308): ticks every second while a preview is shown.
  const [quoteNowMs, setQuoteNowMs] = useState(() => Date.now());
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!preview) return;
    const id = setInterval(() => setQuoteNowMs(Date.now()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  const isStaleQuote = preview
    ? isWithdrawQuoteStale(preview, quoteNowMs)
    : false;
  const quoteAgeSecs = preview
    ? withdrawQuoteAgeSeconds(preview.quotedAt, quoteNowMs)
    : null;

  const refreshPreview = useCallback(() => {
    setQuoteNowMs(Date.now());
    setRefreshNonce((n) => n + 1);
  }, []);

  // Issue #1152: recovery primitives for protected flows (share-balance /
  // preview reads and the withdrawal submission below) that assume a live
  // wallet session.
  const {
    pendingRecovery,
    runProtected,
    reconnectAndResume,
    retryPending,
    cancelPending,
    isReconnecting,
  } = useProtectedWalletAction();

  const fetchShareBalance = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const shares = await getUserShares(walletAddress);
      setShareBalance(shares);
      setBalanceError(null);
    } catch (err) {
      setBalanceError(
        err instanceof Error ? err.message : "Could not load share balance",
      );
    }
  }, [walletAddress]);

  // The share-balance read backs the withdrawal preview (max amount, balance
  // validation) and requires a live wallet session — treated as the
  // "quote preview" protected flow for this panel. An expired session here
  // surfaces recovery instead of leaving the balance silently stale/blank.
  const refreshBalance = useCallback(async () => {
    await runProtected("Load withdrawal preview", fetchShareBalance);
  }, [runProtected, fetchShareBalance]);

  useEffect(() => {
    void refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // ── Fetch withdrawal preview ──────────────────────────────────────────────
  useEffect(() => {
    // Clear previous debounce
    if (previewDebounce.current) {
      clearTimeout(previewDebounce.current);
    }

    // Reset preview when input is cleared
    if (!amount || !amount.trim()) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let shares: bigint;
    try {
      shares = parseDecimalToStroops(amount, vaultToken.decimals);
    } catch {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    if (shares <= 0n) {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    const amountUsd = stroopsToUsd(shares, vaultToken.decimals);

    setPreviewLoading(true);
    setPreviewError(null);

    previewDebounce.current = setTimeout(() => {
      const baseUrl = getApiBaseUrlOrNull();
      if (!baseUrl) {
        // No backend — compute client-side fallback so the user still sees a preview
        const now = new Date();
        const fallbackPreview: WithdrawalPreview = {
          vaultId,
          requestedAmountUsd: amountUsd,
          exitFeeUsd: 0,
          exitFeeBps: 0,
          processingDelayLabel: "Instant (~5 seconds on-chain)",
          processingDelaySeconds: 5,
          estimatedNetUsd: amountUsd,
          optimisticNetUsd: amountUsd,
          conservativeNetUsd: amountUsd,
          priceImpactPct: 0,
          isLowLiquidity: false,
          quotedAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + WITHDRAW_QUOTE_TTL_MS,
          ).toISOString(),
          quoteTtlMs: WITHDRAW_QUOTE_TTL_MS,
        };
        setPreview(fallbackPreview);
        setPreviewLoading(false);
        return;
      }

      // Fetch from API — we use a mock liquidity depth for now; in production
      // this would be read from the vault's on-chain state.
      const MOCK_POOL_LIQUIDITY_USD = 500_000;

      apiFetch(`${baseUrl}/api/vaults/${vaultId}/withdrawal-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUsd,
          poolLiquidityUsd: MOCK_POOL_LIQUIDITY_USD,
          exitFeeBps: 0,
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              message?: string;
            };
            throw new Error(body.message ?? `HTTP ${res.status}`);
          }
          return res.json() as Promise<WithdrawalPreview>;
        })
        .then((data) => {
          setPreview(data);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          setPreviewError(
            err instanceof Error ? err.message : "Preview failed",
          );
          setPreview(null);
        })
        .finally(() => {
          setPreviewLoading(false);
        });
    }, 400); // 400 ms debounce

    return () => {
      if (previewDebounce.current) clearTimeout(previewDebounce.current);
    };
  }, [amount, vaultId, vaultToken.decimals, refreshNonce]);

  const emitPhase = useCallback((p: TxPhase) => {
    setTxPhase(p);
    if (p !== "success" && p !== "failure") {
      setLastProgressPhase(p);
    }
  }, []);

  const executeWithdraw = useCallback(async () => {
    if (!walletAddress) return;

    // Block submission when preview data is still loading or missing due to
    // a network error — the user must see the preview before confirming.
    if (previewLoading) return;
    if (!preview && previewError) {
      setError(
        "Preview data is unavailable. Resolve the issue above before submitting.",
      );
      return;
    }
    // Stale quotes must be refreshed before signing (#1308).
    if (preview && isWithdrawQuoteStale(preview)) {
      setError("Quote expired. Refresh the preview and try again.");
      return;
    }

    let shares: bigint;
    try {
      shares = parseDecimalToStroops(amount, vaultToken.decimals);
    } catch {
      setError("Enter a valid amount");
      return;
    }
    if (shares <= 0n) return;
    if (shareBalance !== null && shares > shareBalance) {
      setError("Amount exceeds your share balance");
      return;
    }

    setLastProgressPhase("idle");
    setTxPhase("idle");
    setTxHash(null);
    setError("");
    setShowFailedModal(false);
    setSubmitting(true);

    try {
      const result = await withdraw(walletAddress, shares, emitPhase);
      if (!result.success) {
        throw new Error(result.error || "Withdrawal failed");
      }
      setTxHash(result.hash ?? null);
      setAmount("");
      setPreview(null);
      void refreshBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdrawal failed");
      setShowFailedModal(true);
    } finally {
      setSubmitting(false);
    }
  }, [
    walletAddress,
    amount,
    vaultToken.decimals,
    shareBalance,
    emitPhase,
    refreshBalance,
    preview,
    previewError,
    previewLoading,
  ]);

  // Issue #1152: check for an expired session immediately before submitting
  // the withdrawal (transaction submission is the second protected flow
  // named in the issue). An expired session captures executeWithdraw as a
  // resumable action and surfaces recovery instead of an uncaught error
  // from deep inside withdraw()/the signing adapter.
  const handleWithdraw = useCallback(async () => {
    await runProtected("Withdraw", executeWithdraw);
  }, [runProtected, executeWithdraw]);

  const retryWithdraw = useCallback(() => {
    setError("");
    void handleWithdraw();
  }, [handleWithdraw]);

  const setMax = useCallback(() => {
    if (shareBalance === null) return;
    setAmount(formatStroopsToDecimal(shareBalance, vaultToken.decimals));
  }, [shareBalance, vaultToken.decimals]);

  // Preview is required before submission; it blocks when an API error occurred.
  const previewMissing = Boolean(amount && previewError && !preview);
  const staleBlocked = Boolean(preview && !previewLoading && isStaleQuote);

  if (!walletAddress) {
    return (
      <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-8 text-center">
        <ArrowUpFromLine className="w-12 h-12 text-yellow-400 mx-auto mb-4" />
        <h3 className="text-xl font-bold text-white mb-2">
          Withdraw from vault
        </h3>
        <p className="text-gray-400">
          Connect your wallet to redeem shares for the underlying asset
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-6 max-w-md mx-auto">
      {pendingRecovery && (
        <SessionExpiredRecovery
          actionLabel={pendingRecovery.label}
          onReconnect={() => void reconnectAndResume()}
          onRetry={() => void retryPending()}
          onCancel={cancelPending}
          isReconnecting={isReconnecting}
        />
      )}

      {showFailedModal && error && (
        <TransactionFailedModal
          error={decodeTransactionError(error)}
          onClose={() => setShowFailedModal(false)}
          onRetry={() => {
            setShowFailedModal(false);
            retryWithdraw();
          }}
          failurePhase={
            lastProgressPhase !== "idle" &&
            lastProgressPhase !== "success" &&
            lastProgressPhase !== "failure"
              ? lastProgressPhase
              : "polling"
          }
        />
      )}

      <div className="flex items-center gap-2 mb-6">
        <ArrowUpFromLine className="w-5 h-5 text-yellow-400" />
        <h3 className="text-lg font-bold text-white">Withdraw</h3>
      </div>

      {balanceError && (
        <p className="text-xs text-amber-300 mb-3">{balanceError}</p>
      )}

      <div className="bg-white/5 rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-gray-400">Shares to redeem</label>
          <button
            type="button"
            onClick={setMax}
            disabled={shareBalance === null}
            className="text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-50"
          >
            Max:{" "}
            {shareBalance !== null
              ? formatStroopsToDecimal(shareBalance, vaultToken.decimals)
              : "…"}
          </button>
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError("");
          }}
          placeholder="0.00"
          aria-label="Shares to redeem"
          className="w-full bg-transparent text-white text-2xl outline-none"
        />
      </div>

      {/* ── Withdrawal preview ── */}
      <div className="mb-4">
        <PreviewPanel
          preview={preview}
          loading={previewLoading}
          error={previewError}
          isStale={isStaleQuote && !previewLoading}
          quoteAgeSecs={quoteAgeSecs}
          onRefresh={refreshPreview}
        />
      </div>

      {error && txPhase !== "failure" && (
        <p className="text-sm text-red-400 mb-4">{error}</p>
      )}

      <TxStatusTimeline
        steps={TX_PHASE_PIPELINE}
        phase={txPhase}
        errorMessage={txPhase === "failure" ? error : null}
        txHash={txHash}
        failedAtPhase={
          txPhase === "failure"
            ? lastProgressPhase !== "idle"
              ? lastProgressPhase
              : "polling"
            : null
        }
        onRetry={txPhase === "failure" ? retryWithdraw : undefined}
        className="mb-4"
      />

      <button
        type="button"
        onClick={() => void handleWithdraw()}
        disabled={
          submitting ||
          !amount ||
          previewLoading ||
          previewMissing ||
          staleBlocked
        }
        aria-disabled={
          submitting ||
          !amount ||
          previewLoading ||
          previewMissing ||
          staleBlocked
        }
        className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {submitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Processing…
          </>
        ) : previewLoading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading preview…
          </>
        ) : previewMissing ? (
          <>
            <AlertTriangle className="w-4 h-4" />
            Preview required
          </>
        ) : staleBlocked ? (
          <>
            <Clock className="w-4 h-4" />
            Quote stale — refresh
          </>
        ) : (
          <>
            <ArrowUpFromLine className="w-4 h-4" />
            Withdraw
          </>
        )}
      </button>
    </div>
  );
}
