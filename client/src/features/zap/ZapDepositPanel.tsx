import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Zap, Loader2, AlertTriangle, RefreshCw, Clock, Info, Ban, ShieldAlert } from "lucide-react";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import TransactionFailedModal from "../../components/transaction/TransactionFailedModal";
import { decodeTransactionError } from "../../utils/errorDecoder";
import { zapDeposit } from "../../services/soroban";
import type { TxPhase } from "../../services/transactionPhase";
import { TX_PHASE_PIPELINE } from "../../services/transactionPhase";
<import { fetchSwapQuote, fetchVerifyQuote, isQuoteExpiredLocal, verifySwapQuote } from "./fetchSwapQuote";
import { minAmountAfterSlippage } from "./slippage";
import {
  buildZapQuoteRequestKey,
  isZapQuoteExpired,
  quoteAgeSeconds,
  recalculateMinOut,
} from "./quoteFreshness";
import { parseDecimalToStroops, formatStroopsToDecimal } from "./amount";
import {
  buildSelectableZapAssetsFromMetadata,
  fetchZapSupportedAssetsMetadata,
  getVaultContractIdFromEnv,
  getVaultTokenFromEnv,
  loadZapAssetOptions,
  mergeVaultIntoZapSelectableAssets,
  shouldLoadZapMetadataFromApi,
} from "./assets";
import type { ZapAssetOption, ZapQuoteResponse } from "./types";
import { useSettings } from "../settings/SettingsContext";
import { resolveSlippage } from "../settings/types";
import DepositRouteMaterialImpactWarning from "./DepositRouteMaterialImpactWarning";
import { useDepositImpact } from "./useDepositImpact";
import type { QuoteSnapshot } from "./useDepositImpact";

export interface ZapDepositPanelProps {
  walletAddress: string | null;
}

const MIN_SLIPPAGE = 0.1;
const MAX_SLIPPAGE = 15;
const FALLBACK_SOURCE = "fallback_rate";

export default function ZapDepositPanel({ walletAddress }: ZapDepositPanelProps) {
  const useApiAssets = shouldLoadZapMetadataFromApi();
  const { settings } = useSettings();
  const settingsSlippage = resolveSlippage(settings);

  const initialVault = useMemo(() => getVaultTokenFromEnv(), []);
  const initialVaultContractId = useMemo(() => getVaultContractIdFromEnv(), []);

  const [vaultToken, setVaultToken] = useState<ZapAssetOption>(initialVault);
  const [vaultContractId, setVaultContractId] = useState(initialVaultContractId);
  const [selectableAssets, setSelectableAssets] = useState<ZapAssetOption[]>(() =>
    mergeVaultIntoZapSelectableAssets(loadZapAssetOptions(), initialVault),
  );

  useEffect(() => {
    if (!useApiAssets) return;
    let cancelled = false;
    void fetchZapSupportedAssetsMetadata().then((meta) => {
      if (cancelled || !meta) return;
      setVaultToken(meta.vaultToken);
      setVaultContractId(meta.vaultContractId);
      setSelectableAssets(buildSelectableZapAssetsFromMetadata(meta));
    });
    return () => {
      cancelled = true;
    };
  }, [useApiAssets]);

  const [inputAsset, setInputAsset] = useState<ZapAssetOption | null>(
    () => mergeVaultIntoZapSelectableAssets(loadZapAssetOptions(), initialVault)[0] ?? null,
  );

  useEffect(() => {
    if (!selectableAssets.length) return;
    if (
      !inputAsset ||
      !selectableAssets.some((a) => a.contractId === inputAsset.contractId)
    ) {
      const next = selectableAssets[0] ?? null;
      Promise.resolve().then(() => setInputAsset(next));
    }
  }, [inputAsset, selectableAssets]);

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const lastProgressPhaseRef = useRef<TxPhase>("idle");
  const [lastProgressPhase, setLastProgressPhase] = useState<TxPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showFailedModal, setShowFailedModal] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [expectedOut, setExpectedOut] = useState<bigint | null>(null);
  const [quotePath, setQuotePath] = useState<string>("");
  const [quoteSource, setQuoteSource] = useState<string>("");
  const [quoteData, setQuoteData] = useState<ZapQuoteResponse | null>(null);
  const [slippageTolerance, setSlippageTolerance] = useState(settingsSlippage);
  const [showSlippageEdit, setShowSlippageEdit] = useState(false);
  const prevExpectedOutRef = useRef<bigint | null>(null);
  // Safety envelope: fallback acknowledgment + expiry/freeze tracking
  const [fallbackAcknowledged, setFallbackAcknowledged] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [confirmFallbackForTest] = useState(false);
  // Tracks the most recently fetched route, independent of React state, so a
  // route-path change can be detected even when the headline output amount
  // stays nominally the same between fetches.
  const latestRouteRef = useRef<string[] | null>(null);
  const prevRouteRef = useRef<string[] | null>(null);
  const [quoteNowMs, setQuoteNowMs] = useState(Date.now());
  const quoteRequestSeqRef = useRef(0);

  const needsSwap = inputAsset?.contractId !== vaultToken.contractId;

  useEffect(() => {
    prevExpectedOutRef.current = null;
    setExpectedOut(null);
    setQuotePath("");
    setQuoteSource("");
    setQuoteData(null);
  }, [inputAsset?.contractId, vaultToken.contractId]);

  useEffect(() => {
    if (!quoteData) return;
    const id = setInterval(() => setQuoteNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quoteData]);

  const refreshQuote = useCallback(async () => {
    if (!inputAsset || !amount || !vaultToken.contractId) {
      prevExpectedOutRef.current = null;
      prevRouteRef.current = null;
      latestRouteRef.current = null;
      setExpectedOut(null);
      setQuotePath("");
      setQuoteData(null);
      setVerifyError("");
      return;
    }
    let stroops: bigint;
    try {
      stroops = parseDecimalToStroops(amount, inputAsset.decimals);
    } catch {
      setExpectedOut(null);
      return;
    }
    if (stroops <= 0n) {
      setExpectedOut(null);
      return;
    }

    setQuoteLoading(true);
    setError("");
    setVerifyError("");
    const requestSeq = ++quoteRequestSeqRef.current;
    const requestKey = buildZapQuoteRequestKey({
      inputTokenContract: inputAsset.contractId,
      vaultTokenContract: vaultToken.contractId,
      amountInStroops: stroops.toString(),
      slippageTolerance,
    });
    try {
      if (!needsSwap) {
        if (requestSeq !== quoteRequestSeqRef.current) return;
        prevExpectedOutRef.current = expectedOut;
        prevRouteRef.current = latestRouteRef.current;
        latestRouteRef.current = null;
        setExpectedOut(stroops);
        setQuotePath(`${inputAsset.symbol} (no swap)`);
        setQuoteSource("direct");
        setQuoteData(null);
        setFallbackAcknowledged(false);
      } else {
        const q = await fetchSwapQuote({
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          amountInStroops: stroops.toString(),
          inputDecimals: inputAsset.decimals,
          vaultDecimals: vaultToken.decimals,
          slippageTolerance: slippageTolerance / 100,
        });
        if (requestSeq !== quoteRequestSeqRef.current) return;
        const responseKey = buildZapQuoteRequestKey({
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          amountInStroops: stroops.toString(),
          slippageTolerance,
        });
        if (responseKey !== requestKey) return;
        prevExpectedOutRef.current = expectedOut;
        prevRouteRef.current = latestRouteRef.current;
        latestRouteRef.current = q.path.map((h) => h.contractId);
        setExpectedOut(BigInt(q.expectedAmountOutStroops));
        setQuotePath(q.path.map((h) => h.label ?? h.contractId.slice(0, 6)).join(" → "));
        setQuoteSource(q.source);
        setQuoteData(q);
        // Reset fallback ack on new quote — prevents silently carrying over acknowledgment
        setFallbackAcknowledged(false);
        if (confirmFallbackForTest) {
          // keep test helper
        }
        setQuoteNowMs(Date.now());
      }
    } catch (e) {
      if (requestSeq !== quoteRequestSeqRef.current) return;
      prevExpectedOutRef.current = null;
      prevRouteRef.current = null;
      latestRouteRef.current = null;
      setExpectedOut(null);
      setError(e instanceof Error ? e.message : "Could not load quote");
      setQuoteData(null);
    } finally {
      if (requestSeq === quoteRequestSeqRef.current) {
        setQuoteLoading(false);
      }
    }
<  }, [amount, inputAsset, needsSwap, slippageTolerance, vaultToken, expectedOut, confirmFallbackForTest]);

  useEffect(() => {
    const t = setTimeout(() => {
      void refreshQuote();
    }, 350);
    return () => clearTimeout(t);
  }, [refreshQuote]);

  const minOut = useMemo(() => {
    if (expectedOut === null || expectedOut <= 0n) return null;
    // Prefer server-bound minAmountOutStroops if present (safety envelope), otherwise compute locally
    if (quoteData?.minAmountOutStroops) {
      try {
        const serverMin = BigInt(quoteData.minAmountOutStroops);
        if (serverMin > 0n) return serverMin;
      } catch {
        // fall through to computed
      }
    }
    return minAmountAfterSlippage(expectedOut, slippageTolerance);
  }, [expectedOut, slippageTolerance, quoteData]);

  const isExpired = useMemo(() => {
    if (!quoteData) return false;
    // Prefer explicit expiresAt/ttlMs (our envelope), fallback to upstream's isZapQuoteExpired
    if (quoteData.expiresAt || quoteData.ttlMs !== undefined) {
      return isQuoteExpiredLocal(quoteData);
    }
    return isZapQuoteExpired(quoteData, quoteNowMs);
  }, [quoteData, quoteNowMs]);

  const isStale = useMemo(() => {
    if (!quoteData) return false;
    if (isExpired) return true;
    return quoteAgeSeconds(quoteData.quotedAt) > STALE_QUOTE_AGE_MS / 1000;
  }, [quoteData, isExpired]);

  const isFallback = useMemo(() => {
    if (!quoteData) return false;
    return quoteData.isFallback || quoteData.source === FALLBACK_SOURCE || quoteData.quoteSource === FALLBACK_SOURCE;
  }, [quoteData]);

  const isFrozenQuote = useMemo(() => {
    if (!quoteData) return false;
    return Boolean(quoteData.isFrozen);
  }, [quoteData]);

  const quoteSnapshot = useMemo<QuoteSnapshot | undefined>(() => {
    if (!quoteData || !expectedOut || expectedOut <= 0n) return undefined;
    const minOutVal = minOut ?? minAmountAfterSlippage(expectedOut, slippageTolerance);
    return {
      quotedAt: quoteData.quotedAt,
      route: quoteData.path.map((h) => h.contractId),
      expectedOut,
      minOut: minOutVal,
      prevExpectedOut: prevExpectedOutRef.current ?? undefined,
      prevRoute: prevRouteRef.current ?? undefined,
      isFallback,
      isStale,
      source: quoteData.source,
    };
  }, [quoteData, expectedOut, slippageTolerance, isFallback, isStale, minOut]);

  const depositImpact = useDepositImpact({
    amountUsd: 0,
    slippageTolerance,
    isFallback,
    isStale,
    quote: quoteSnapshot,
    blockStaleQuotes: true,
  });

  const emitPhase = useCallback((p: TxPhase) => {
    setTxPhase(p);
    if (p !== "success" && p !== "failure") {
      lastProgressPhaseRef.current = p;
      setLastProgressPhase(p);
    }
  }, []);

  const handleSlippageChange = useCallback((value: number) => {
    const clamped = Math.min(MAX_SLIPPAGE, Math.max(MIN_SLIPPAGE, value));
    setSlippageTolerance(clamped);
  }, []);

  const handleZap = useCallback(async () => {
    if (!walletAddress || !inputAsset || !vaultContractId || !vaultToken.contractId) return;
    let amountIn: bigint;
    try {
      amountIn = parseDecimalToStroops(amount, inputAsset.decimals);
    } catch {
      setError("Enter a valid amount");
      return;
    }
    if (amountIn <= 0n) return;
    if (minOut === null || minOut <= 0n) {
      setError("Wait for a valid quote or reduce slippage");
      return;
    }
    if (quoteData && isZapQuoteExpired(quoteData)) {
      setError("Quote expired. Refresh and try again.");
      return;
    }

    // Safety envelope: pre-flight checks before contract submission
    if (needsSwap && quoteData) {
      // Stale / expired quotes must requote — never execute with stale assumptions
      if (isExpired || isStale) {
        setError("Quote expired — please refresh for current rates before submitting.");
        setVerifyError("Quote expired — requote required.");
        return;
      }
      if (isFrozenQuote) {
        setError("Protocol is frozen — quoting disabled. Please requote after freeze is lifted.");
        setVerifyError("Protocol frozen — quote invalidated.");
        return;
      }
      if (isFallback && !fallbackAcknowledged) {
        setError("Fallback quote requires acknowledgment — estimated rate, not simulated. Check the acknowledgment to proceed.");
        setVerifyError("Fallback quote — explicit acknowledgment required.");
        return;
      }
      // Verify with backend that quote is still fresh, bound to same pair/route, and not after-freeze
      if (quoteData.quoteId) {
        try {
          setVerifyError("");
          // Local expiry fast-path before network
          if (isQuoteExpiredLocal(quoteData)) {
            throw new Error(`Quote expired at ${quoteData.expiresAt}. Please requote.`);
          }
          await fetchVerifyQuote({
            quoteId: quoteData.quoteId,
            inputTokenContract: inputAsset.contractId,
            vaultTokenContract: vaultToken.contractId,
            amountInStroops: amountIn.toString(),
            protocol: quoteData.protocol,
            path: quoteData.path,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Quote verification failed";
          const code = (e as { code?: string }).code;
          // Distinguish freeze vs expiry for messaging
          if (code === "FROZEN" || msg.toLowerCase().includes("freeze")) {
            setError("Quote invalidated by protocol freeze after it was created. Please requote.");
          } else if (code === "QUOTE_EXPIRED" || msg.toLowerCase().includes("expired")) {
            setError("Quote expired — please refresh for current rates before submitting.");
          } else if (code === "ASSET_MISMATCH" || code === "ROUTE_MISMATCH") {
            setError("Quote route or asset mismatch — please requote with the current pair.");
          } else {
            setError(msg);
          }
          setVerifyError(msg);
          setStatus("error");
          return;
        }
      }
    }

    lastProgressPhaseRef.current = "idle";
    setLastProgressPhase("idle");
    setTxPhase("idle");
    setTxHash(null);
    setStatus("loading");
    setError("");
    setVerifyError("");
    setShowFailedModal(false);
    try {
      if (quoteData) {
        const isValid = await verifySwapQuote(quoteData);
        if (!isValid) {
          setError('Quote validation failed. Please refresh and try again.');
          setShowFailedModal(true);
          return;
        }
      }
      const result = await zapDeposit(
        walletAddress,
        {
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          vaultContractId,
          amountIn,
          minAmountOut: minOut,
          minSharesOut: minOut,
        },
        emitPhase,
        false,
        settings,
      );
      if (!result.success) {
        throw new Error(result.error || "Transaction failed");
      }
      setTxHash(result.hash ?? null);
      setStatus("success");
      setAmount("");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Transaction failed");
      setShowFailedModal(true);
    }
  }, [
    walletAddress,
    inputAsset,
    vaultContractId,
    vaultToken.contractId,
    amount,
    minOut,
    emitPhase,
    settings,
    needsSwap,
    quoteData,
    isExpired,
    isStale,
    isFrozenQuote,
    isFallback,
    fallbackAcknowledged,
    quoteNowMs,
  ]);

  const retryZap = useCallback(() => {
    setError("");
    void handleZap();
  }, [handleZap]);

  const configOk =
    Boolean(vaultContractId) &&
    Boolean(vaultToken.contractId) &&
    selectableAssets.length > 0;

  if (!walletAddress) {
    return (
      <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-8 text-center">
        <Zap className="w-12 h-12 text-yellow-400 mx-auto mb-4" />
        <h3 className="text-xl font-bold text-white mb-2">Zap into vault</h3>
        <p className="text-gray-400">Connect your wallet to swap and deposit in one transaction</p>
      </div>
    );
  }

  return (
    <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-6 max-w-md mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-yellow-400" />
          <h3 className="text-lg font-bold text-white">Zap deposit</h3>
        </div>
        <button
          type="button"
          onClick={() => void refreshQuote()}
          className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-gray-300"
          title="Refresh quote"
        >
          <RefreshCw className={`w-4 h-4 ${quoteLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {!configOk && (
        <div className="mb-4 text-amber-200/90 text-sm flex gap-2 items-start">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Set <code className="text-amber-100">VITE_CONTRACT_ID</code>,{" "}
            <code className="text-amber-100">VITE_VAULT_TOKEN_CONTRACT_ID</code>, and asset contract
            IDs (or <code className="text-amber-100">VITE_ZAP_ASSETS_JSON</code>) in your env.
          </span>
        </div>
      )}

      {/* Frozen state — protocol freeze invalidates pending quotes */}
      {isFrozenQuote && needsSwap && (
        <div className="mb-4 flex items-start gap-2 text-red-200/90 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3" role="alert" aria-live="assertive">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
          <div>
            <p className="font-medium text-red-300">Protocol frozen — quote invalidated</p>
            <p className="text-xs text-red-200/70">
              This quote was created before a safety freeze and can no longer be executed. Please requote after the freeze is lifted.
            </p>
            <button type="button" onClick={() => void refreshQuote()} className="mt-2 text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200">
              Requote
            </button>
          </div>
        </div>
      )}

      {/* Fallback quote warning — must be explicitly acknowledged */}
      {isFallback && needsSwap && (
        <div className="mb-4 flex items-start gap-2 text-amber-200/90 text-sm bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <div className="flex-1">
            <p className="font-medium text-amber-300">Fallback quote active</p>
            <p className="text-xs text-amber-200/70">
              Router simulation unavailable. Using estimated rate. Actual output may differ significantly. This quote cannot be silently treated as a simulated quote.
            </p>
            <label className="mt-2 flex items-center gap-2 text-xs text-amber-200 cursor-pointer">
              <input
                type="checkbox"
                checked={fallbackAcknowledged}
                onChange={(e) => setFallbackAcknowledged(e.target.checked)}
                className="rounded border-amber-500/50 bg-white/10"
              />
              <span>I understand the risk and want to proceed with this estimated quote</span>
            </label>
            {!fallbackAcknowledged && (
              <p className="mt-1 text-[10px] text-amber-300/80">Required to enable Zap with fallback quote.</p>
            )}
          </div>
        </div>
      )}

      {/* Expired / stale quote warning — requires requote */}
      {(isExpired || isStale) && !quoteLoading && needsSwap && quoteData && (
        <div className="mb-4 flex items-start gap-2 text-orange-200/90 text-sm bg-orange-500/10 border border-orange-500/30 rounded-lg p-3">
          <Clock className="w-4 h-4 shrink-0 mt-0.5 text-orange-400" />
          <div className="flex-1">
            <p className="font-medium text-orange-300">{isExpired ? "Quote expired" : "Stale quote"}</p>
            <p className="text-xs text-orange-200/70">
              {isExpired
                ? `Quote expired at ${quoteData.expiresAt ? new Date(quoteData.expiresAt).toLocaleTimeString() : ""}. Execution blocked until you requote.`
                : "Quote is over 60 seconds old. Refresh for current rates."}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshQuote()}
                className="text-xs px-2 py-1 rounded bg-orange-500/20 hover:bg-orange-500/30 text-orange-200"
              >
                Requote now
              </button>
              {quoteData.quoteId && (
                <span className="text-[10px] text-orange-300/60">ID {quoteData.quoteId.slice(0, 8)}…</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Verify error — e.g. asset mismatch after user changed pair without requote */}
      {verifyError && (
        <div className="mb-4 flex items-start gap-2 text-red-200/90 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3" role="alert" aria-live="assertive">
          <Ban className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
          <div>
            <p className="font-medium text-red-300">Quote verification failed</p>
            <p className="text-xs text-red-200/70">{verifyError}</p>
            <button type="button" onClick={() => void refreshQuote()} className="mt-2 text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200">
              Requote
            </button>
          </div>
        </div>
      )}

      <div className="bg-white/5 rounded-xl p-4 mb-2">
        <label className="text-sm text-gray-400 mb-2 block">You pay</label>
        <div className="flex gap-3">
          <select
            value={inputAsset?.contractId ?? ""}
            onChange={(e) => {
              const a = selectableAssets.find((x) => x.contractId === e.target.value);
              if (a) setInputAsset(a);
            }}
            className="bg-white/10 text-white rounded-lg px-3 py-2 border border-white/10 max-w-[40%]"
            disabled={!selectableAssets.length}
          >
            {selectableAssets.map((t) => (
              <option key={t.contractId} value={t.contractId}>
                {t.symbol}
              </option>
            ))}
          </select>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-white text-right text-2xl outline-none"
          />
        </div>
      </div>

      <div className="flex justify-center my-2">
        <div className="bg-white/10 rounded-full p-2">
          <ArrowDown className="w-4 h-4 text-gray-400" />
        </div>
      </div>

      <div className="bg-white/5 rounded-xl p-4 mb-4 space-y-2">
        <label className="text-sm text-gray-400 block">Expected to receive (before deposit)</label>
        <div className="flex items-center justify-between gap-2">
          <span className="text-white font-medium">
            {expectedOut !== null && expectedOut > 0n
              ? `${formatStroopsToDecimal(expectedOut, vaultToken.decimals)} ${vaultToken.symbol}`
              : quoteLoading
                ? "…"
                : "—"}
          </span>
          <span className="text-gray-500 text-xs text-right">
            {needsSwap ? "Vault token after swap" : "Vault token"}
          </span>
        </div>

        {/* Min output after slippage */}
        {minOut !== null && minOut > 0n && (
          <p className="text-xs text-gray-400">
            Min. after {slippageTolerance}% slippage:{" "}
            <span className="text-gray-200 font-mono">
              {formatStroopsToDecimal(minOut, vaultToken.decimals)} {vaultToken.symbol}
            </span>
          </p>
        )}

        {/* Quote source badge */}
        {quoteSource && needsSwap && (
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              quoteSource === "router_simulation"
                ? "bg-green-500/20 text-green-400"
                : quoteSource === "fallback_rate"
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-blue-500/20 text-blue-400"
            }`}>
              {quoteSource === "router_simulation" ? "Simulated" : quoteSource === "fallback_rate" ? "Fallback" : quoteSource}
            </span>

            {/* Quote age */}
            {quoteData && (
              <span className="text-[10px] text-gray-500 flex items-center gap-1">
                <Clock size={10} />
                {quoteAgeSeconds(quoteData.quotedAt, quoteNowMs)}s ago
              </span>
            )}
            {/* TTL / expiry */}
            {quoteData?.expiresAt && (
              <span className="text-[10px] text-gray-500">
                expires {new Date(quoteData.expiresAt).toLocaleTimeString()}
              </span>
            )}
            {/* Quote ID for audit / support */}
            {quoteData?.quoteId && (
              <span className="text-[10px] text-gray-600 font-mono" title={quoteData.quoteId}>
                {quoteData.quoteId.slice(0, 8)}
              </span>
            )}
          </div>
        )}

        {quotePath && (
          <p className="text-xs text-gray-500">
            Path: {quotePath}
          </p>
        )}
        {quoteData && isFallback && (
          <p className="text-[10px] text-amber-300/70">Fallback quotes are estimated — not router-simulated. Requires explicit acknowledgment.</p>
        )}
      </div>

      {/* Slippage tolerance editor */}
      {needsSwap && (
        <div className="bg-white/5 rounded-xl p-3 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1">
              <span className="text-sm text-gray-400">Slippage tolerance</span>
              <button
                type="button"
                onClick={() => setShowSlippageEdit(!showSlippageEdit)}
                className="text-gray-500 hover:text-gray-300"
              >
                <Info size={12} />
              </button>
            </div>
            <span className={`text-sm font-medium ${
              slippageTolerance > 5 ? "text-red-400" : slippageTolerance > 2 ? "text-amber-400" : "text-white"
            }`}>
              {slippageTolerance}%
            </span>
          </div>

          {showSlippageEdit && (
            <div className="space-y-2">
              <div className="flex gap-2">
                {[0.1, 0.5, 1, 2, 3, 5].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => handleSlippageChange(val)}
                    className={`text-xs px-2 py-1 rounded ${
                      slippageTolerance === val
                        ? "bg-[#6C5DD3] text-white"
                        : "bg-white/10 text-gray-400 hover:bg-white/20"
                    }`}
                  >
                    {val}%
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={MIN_SLIPPAGE}
                  max={MAX_SLIPPAGE}
                  step={0.1}
                  value={slippageTolerance}
                  onChange={(e) => handleSlippageChange(parseFloat(e.target.value))}
                  className="flex-1 accent-[#6C5DD3]"
                />
                <span className="text-xs text-gray-500 w-10 text-right">{slippageTolerance}%</span>
              </div>
              {slippageTolerance >= 5 && (
                <p className="text-xs text-red-400 flex items-center gap-1">
                  <AlertTriangle size={10} />
                  High slippage may result in significant price impact
                </p>
              )}
              {slippageTolerance < 0.5 && (
                <p className="text-xs text-amber-400 flex items-center gap-1">
                  <Info size={10} />
                  Very low slippage may cause transaction to fail if price moves slightly.
                </p>
              )}
              <p className="text-[10px] text-gray-500">
                Safe range: {MIN_SLIPPAGE}% – {MAX_SLIPPAGE}%. Higher tolerance means more risk of unfavorable rate. Low tolerance may fail.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Deposit route impact warning */}
      {needsSwap && amount && parseFloat(amount) > 0 && (
        <div className="mb-4">
          <DepositRouteMaterialImpactWarning
            amountUsd={0}
            slippageTolerance={slippageTolerance}
            isFallback={isFallback}
            isStale={isStale}
            quote={quoteSnapshot}
            blockStaleQuotes={true}
          />
        </div>
      )}

      {error && txPhase !== "failure" && (
        <div className="flex items-center gap-2 text-red-400 text-sm mb-4">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {showFailedModal && txPhase === "failure" && error && (
        <TransactionFailedModal
          error={decodeTransactionError(error)}
          onClose={() => setShowFailedModal(false)}
          onRetry={() => {
            setShowFailedModal(false);
            retryZap();
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
        onRetry={txPhase === "failure" ? retryZap : undefined}
        className="mb-4"
      />

      {/* Blocked state banner */}
      {depositImpact.shouldBlock && (
        <div
          className="mb-4 flex items-center gap-2 text-red-300 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3"
          role="alert"
          aria-live="assertive"
        >
          <Ban className="w-4 h-4 shrink-0" />
          <span>{depositImpact.blockReason}</span>
        </div>
      )}

      <button
        type="button"
        onClick={() => void handleZap()}
        disabled={
          !configOk ||
          !amount ||
          status === "loading" ||
          minOut === null ||
          minOut <= 0n ||
          depositImpact.shouldBlock ||
          (needsSwap && isExpired) ||
          (needsSwap && isFallback && !fallbackAcknowledged) ||
          Boolean(verifyError && needsSwap)
        }
        className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        title={
          needsSwap && isExpired
            ? "Quote expired — requote required"
            : needsSwap && isFallback && !fallbackAcknowledged
              ? "Acknowledge fallback quote risk to proceed"
              : undefined
        }
      >
        {status === "loading" ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Processing…
          </>
        ) : status === "success" ? (
          "Zap successful"
        ) : needsSwap ? (
          <>
            <Zap className="w-4 h-4" />
            Zap deposit
          </>
        ) : (
          "Deposit"
        )}
      </button>

      <p className="text-xs text-gray-500 text-center mt-3">
        One signed transaction: tokens move into the Zap contract, swap if needed with on-chain
        slippage checks, then shares are minted to your address. If the swap would deliver less than
        the minimum, the whole transaction reverts. Quotes expire in ~60s and are invalidated by freezes — requote if blocked.
      </p>
    </div>
  );
}
