import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Zap, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import TxStatusTimeline from "../../components/transaction/TxStatusTimeline";
import { zapDeposit } from "../../services/soroban";
import type { TxPhase } from "../../services/transactionPhase";
import { TX_PHASE_PIPELINE } from "../../services/transactionPhase";
import { fetchSwapQuote } from "./fetchSwapQuote";
import { minAmountAfterSlippage } from "./slippage";
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
import type { ZapAssetOption } from "./types";
import { useSettings } from "../settings/SettingsContext";
import { resolveSlippage } from "../settings/types";

export interface ZapDepositPanelProps {
  walletAddress: string | null;
}

export default function ZapDepositPanel({ walletAddress }: ZapDepositPanelProps) {
  const useApiAssets = shouldLoadZapMetadataFromApi();
  const { settings } = useSettings();
  const slippage = resolveSlippage(settings);

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
      setInputAsset(selectableAssets[0] ?? null);
    }
  }, [inputAsset, selectableAssets]);

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const lastProgressPhaseRef = useRef<TxPhase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [expectedOut, setExpectedOut] = useState<bigint | null>(null);
  const [quotePath, setQuotePath] = useState<string>("");
  const [quoteSource, setQuoteSource] = useState<string>("");

  const needsSwap = inputAsset?.contractId !== vaultToken.contractId;

  const refreshQuote = useCallback(async () => {
    if (!inputAsset || !amount || !vaultToken.contractId) {
      setExpectedOut(null);
      setQuotePath("");
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
    try {
      if (!needsSwap) {
        setExpectedOut(stroops);
        setQuotePath(`${inputAsset.symbol} (no swap)`);
        setQuoteSource("direct");
      } else {
        const q = await fetchSwapQuote({
          inputTokenContract: inputAsset.contractId,
          vaultTokenContract: vaultToken.contractId,
          amountInStroops: stroops.toString(),
          inputDecimals: inputAsset.decimals,
          vaultDecimals: vaultToken.decimals,
        });
        setExpectedOut(BigInt(q.expectedAmountOutStroops));
        setQuotePath(q.path.map((h) => h.label ?? h.contractId.slice(0, 6)).join(" → "));
        setQuoteSource(q.source);
      }
    } catch (e) {
      setExpectedOut(null);
      setError(e instanceof Error ? e.message : "Could not load quote");
    } finally {
      setQuoteLoading(false);
    }
  }, [amount, inputAsset, needsSwap, vaultToken]);

  useEffect(() => {
    const t = setTimeout(() => {
      void refreshQuote();
    }, 350);
    return () => clearTimeout(t);
  }, [refreshQuote]);

  const minOut = useMemo(() => {
    if (expectedOut === null || expectedOut <= 0n) return null;
    return minAmountAfterSlippage(expectedOut, slippage);
  }, [expectedOut, slippage]);

  const emitPhase = useCallback((p: TxPhase) => {
    setTxPhase(p);
    if (p !== "success" && p !== "failure") {
      lastProgressPhaseRef.current = p;
    }
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

    lastProgressPhaseRef.current = "idle";
    setTxPhase("idle");
    setTxHash(null);
    setStatus("loading");
    setError("");
    try {
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
    }
  }, [
    walletAddress,
    inputAsset,
    vaultContractId,
    vaultToken.contractId,
    amount,
    minOut,
    emitPhase,
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
        {minOut !== null && minOut > 0n && (
          <p className="text-xs text-gray-400">
            Min. after {slippage}% slippage:{" "}
            <span className="text-gray-200 font-mono">
              {formatStroopsToDecimal(minOut, vaultToken.decimals)} {vaultToken.symbol}
            </span>
          </p>
        )}
        {quotePath && (
          <p className="text-xs text-gray-500">
            Path: {quotePath}
            {quoteSource && ` · ${quoteSource}`}
          </p>
        )}
      </div>

      {needsSwap && (
        <div className="bg-white/5 rounded-xl p-3 mb-4 flex items-center justify-between text-sm">
          <span className="text-gray-400">Slippage tolerance</span>
          <span className="text-white font-medium">{slippage}%</span>
        </div>
      )}

      {error && txPhase !== "failure" && (
        <div className="flex items-center gap-2 text-red-400 text-sm mb-4">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <TxStatusTimeline
        steps={TX_PHASE_PIPELINE}
        phase={txPhase}
        errorMessage={txPhase === "failure" ? error : null}
        txHash={txHash}
        failedAtPhase={
          txPhase === "failure"
            ? lastProgressPhaseRef.current !== "idle"
              ? lastProgressPhaseRef.current
              : "polling"
            : null
        }
        onRetry={txPhase === "failure" ? retryZap : undefined}
        className="mb-4"
      />

      <button
        type="button"
        onClick={() => void handleZap()}
        disabled={
          !configOk ||
          !amount ||
          status === "loading" ||
          minOut === null ||
          minOut <= 0n
        }
        className="w-full py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
        the minimum, the whole transaction reverts.
      </p>
    </div>
  );
}
