import React, { useState, useMemo, useEffect } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Clock,
  Layers,
  AlertTriangle,
  Fingerprint,
} from "lucide-react";
import {
  formatShortFingerprint,
  verifyQuoteAssumptionFingerprint,
  type QuoteAssumptions,
  type FingerprintVerificationResult,
} from "../../../../shared/types/quoteAssumptionFingerprint";

export interface QuoteAssumptionFingerprintDisplayProps {
  /** The immutable mathematical assumptions used to derive the quote. */
  assumptions?: QuoteAssumptions | null;
  /** Claimed cryptographic fingerprint hex from the server or quote engine. */
  fingerprint?: string;
  /** Whether the quote or fingerprint is currently calculating or fetching. */
  isLoading?: boolean;
  /** Any fetch or quote failure error message. */
  error?: string | null;
  /** Whether the quote is marked as stale or expired by the parent flow. */
  isStale?: boolean;
  /** Callback triggered when user requests a re-quote/refresh. */
  onRefresh?: () => void;
  /** Whether to show in compact mode (e.g. inside an inline form vs modal). */
  compact?: boolean;
  /** Initial expansion state of the assumption details accordion. */
  initialExpanded?: boolean;
  /** Additional custom class names. */
  className?: string;
}

export function QuoteAssumptionFingerprintDisplay({
  assumptions,
  fingerprint,
  isLoading = false,
  error = null,
  isStale = false,
  onRefresh,
  compact = false,
  initialExpanded = false,
  className = "",
}: QuoteAssumptionFingerprintDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick clock every second for live TTL evaluation
  useEffect(() => {
    if (!assumptions?.expiresAt) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [assumptions?.expiresAt]);

  // Compute live verification against active assumptions and claimed fingerprint
  const verification: FingerprintVerificationResult | null = useMemo(() => {
    if (!assumptions || !fingerprint) return null;
    return verifyQuoteAssumptionFingerprint(assumptions, fingerprint, { nowMs });
  }, [assumptions, fingerprint, nowMs]);

  const shortFp = useMemo(() => {
    return fingerprint ? formatShortFingerprint(fingerprint) : "";
  }, [fingerprint]);

  const handleCopy = async () => {
    if (!fingerprint) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fingerprint);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = fingerprint;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures gracefully
    }
  };

  const expiresAt = assumptions?.expiresAt;
  const remainingSeconds = useMemo(() => {
    if (!expiresAt) return null;
    const exp = new Date(expiresAt).getTime();
    if (!Number.isFinite(exp)) return null;
    return Math.max(0, Math.ceil((exp - nowMs) / 1000));
  }, [expiresAt, nowMs]);

  // ── State 1: Loading ─────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        data-testid="fingerprint-loading"
        role="status"
        aria-busy="true"
        aria-live="polite"
        className={`rounded-xl border border-white/10 bg-white/5 p-3.5 backdrop-blur-md transition-all ${className}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
              <RefreshCw className="h-4 w-4 animate-spin text-blue-400" />
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-200">
                Computing quote assumption fingerprint…
              </p>
              <p className="text-[11px] text-gray-400">
                Binding routes, rates, and slippage guarantees
              </p>
            </div>
          </div>
          <div className="h-5 w-24 animate-pulse rounded bg-white/10" />
        </div>
      </div>
    );
  }

  // ── State 2: Explicit Error or Failure ───────────────────────────────────
  if (error) {
    return (
      <div
        data-testid="fingerprint-error"
        role="alert"
        className={`rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 backdrop-blur-md text-red-200 ${className}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <p className="text-xs font-semibold text-red-300">Quote assumption failure</p>
              <p className="text-[11px] text-red-200/80">{error}</p>
            </div>
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs text-red-200 hover:bg-white/20 transition-colors"
              title="Refresh quote"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── State 3: Empty (no quote or amount entered) ──────────────────────────
  if (!assumptions && !fingerprint) {
    return (
      <div
        data-testid="fingerprint-empty"
        className={`rounded-xl border border-dashed border-white/10 bg-white/5 p-3.5 text-center text-gray-400 ${className}`}
      >
        <div className="flex items-center justify-center gap-2 text-xs">
          <Fingerprint className="h-4 w-4 text-gray-500" />
          <span>Enter an amount to generate a quote and cryptographic assumption fingerprint.</span>
        </div>
      </div>
    );
  }

  // ── State 4: Expired or Stale ────────────────────────────────────────────
  const effectiveExpired = isStale || (verification && verification.status === "expired") || remainingSeconds === 0;

  if (effectiveExpired) {
    return (
      <div
        data-testid="fingerprint-stale"
        role="alert"
        className={`rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 backdrop-blur-md text-amber-200 ${className}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold text-amber-300">Quote assumptions expired</p>
                {shortFp && (
                  <span className="font-mono text-[10px] text-amber-300/70">{shortFp}</span>
                )}
              </div>
              <p className="text-[11px] text-amber-200/80">
                The cryptographic validity window for these assumptions has lapsed. Please refresh for live market rates.
              </p>
            </div>
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/20 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/30 transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── State 5: Drifted / Mismatched ────────────────────────────────────────
  if (verification && verification.status === "drifted") {
    return (
      <div
        data-testid="fingerprint-drifted"
        role="alert"
        className={`rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 backdrop-blur-md text-red-200 ${className}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <p className="text-xs font-semibold text-red-300">Assumption drift detected</p>
              <p className="text-[11px] text-red-200/80">
                {verification.message || "Quote parameters have changed since fingerprint calculation."}
              </p>
            </div>
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-2.5 py-1 text-xs text-red-200 hover:bg-white/20 transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Re-quote
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── State 6: Normal / Verified ───────────────────────────────────────────
  return (
    <div
      data-testid="fingerprint-verified"
      className={`rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5 backdrop-blur-md transition-all ${className}`}
    >
      {/* Header bar: Badge, Short Fingerprint, Copy, TTL */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-emerald-300">Quote fingerprint</span>
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                {shortFp}
              </span>
            </div>
            <span className="text-[10px] text-gray-400">
              Deterministic SHA-256 bound to review parameters
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {remainingSeconds !== null && (
            <span
              className={`flex items-center gap-1 text-[11px] font-mono ${
                remainingSeconds <= 15 ? "text-amber-400 animate-pulse" : "text-gray-400"
              }`}
              title="Quote validity expires in"
            >
              <Clock className="h-3 w-3" />
              {remainingSeconds}s
            </span>
          )}

          <button
            type="button"
            onClick={() => void handleCopy()}
            data-testid="copy-fingerprint-btn"
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white transition-colors"
            title={copied ? "Copied full SHA-256!" : "Copy full cryptographic fingerprint"}
            aria-label="Copy quote assumption fingerprint"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
          </button>

          {!compact && (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              data-testid="toggle-breakdown-btn"
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white transition-colors"
              title={isExpanded ? "Hide assumptions breakdown" : "View assumptions breakdown"}
              aria-expanded={isExpanded}
              aria-label="Toggle assumption breakdown"
            >
              {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Copy confirmation notification */}
      {copied && (
        <div className="mt-1.5 text-right">
          <span className="text-[10px] font-medium text-emerald-400">
            Full SHA-256 copied to clipboard
          </span>
        </div>
      )}

      {/* Collapsible Assumptions Breakdown */}
      {isExpanded && assumptions && (
        <div
          data-testid="fingerprint-breakdown"
          className="mt-3 space-y-2 border-t border-white/10 pt-2.5 text-[11px]"
        >
          <div className="grid grid-cols-2 gap-2 text-gray-300">
            <div>
              <span className="text-gray-500 block">Slippage Guarantee</span>
              <span className="font-mono text-gray-200">
                {assumptions.slippageTolerancePct}% tolerance
              </span>
            </div>
            <div>
              <span className="text-gray-500 block">Pricing Model</span>
              <span className="capitalize text-gray-200">
                {assumptions.source === "router_simulation"
                  ? "Router Simulation"
                  : assumptions.source === "fallback_rate"
                  ? "Fallback Rate"
                  : assumptions.source}
              </span>
            </div>
            <div>
              <span className="text-gray-500 block">Min Output Guarantee</span>
              <span className="font-mono text-gray-200">
                {assumptions.minAmountOutStroops} stroops
              </span>
            </div>
            <div>
              <span className="text-gray-500 block">Config Version</span>
              <span className="font-mono text-gray-200" title={assumptions.assetConfigVersion}>
                {assumptions.assetConfigVersion.slice(0, 8)}…
              </span>
            </div>
          </div>

          {assumptions.path && assumptions.path.length > 0 && (
            <div>
              <span className="text-gray-500 block">Verified Swap Hops ({assumptions.path.length})</span>
              <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[10px] text-gray-300">
                {assumptions.path.map((contractId, idx) => (
                  <React.Fragment key={contractId + idx}>
                    <span
                      className="rounded bg-white/10 px-1.5 py-0.5"
                      title={contractId}
                    >
                      {contractId.slice(0, 6)}…{contractId.slice(-4)}
                    </span>
                    {idx < assumptions.path.length - 1 && (
                      <span className="text-gray-500">→</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}

          <div className="pt-1">
            <span className="text-gray-500 block text-[10px]">Full Canonical Hash</span>
            <p className="font-mono text-[9px] text-gray-400 break-all select-all">
              {fingerprint}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default QuoteAssumptionFingerprintDisplay;
