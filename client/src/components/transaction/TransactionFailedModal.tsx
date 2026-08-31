/**
 * TransactionFailedModal.tsx
 *
 * Displays a user-friendly "Transaction Failed" overlay with a friendly
 * message, a suggested fix, and an expandable raw developer log.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Copy, RotateCcw, X } from "lucide-react";
import type { DecodedError } from "../../utils/errorDecoder";
import type { TxPhase } from "../../services/transactionPhase";
import { buildRedactedCopyPayload } from "../../utils/redactClient";

interface TransactionFailedModalProps {
    /** Decoded error object from `decodeTransactionError`. */
    error: DecodedError;
    /** Called when the user dismisses the modal. */
    onClose: () => void;
    /** Optional callback to retry the failed action. */
    onRetry?: () => void;
    /** Optional callback to open richer transaction details pane. */
    onViewDetails?: () => void;
    /** Optional failure phase used to tailor recovery guidance. */
    failurePhase?: Exclude<TxPhase, "idle" | "success">;
    /** Whether wallet appears connected at failure time. */
    walletConnected?: boolean;
    /** Whether network appears healthy/reachable at failure time. */
    networkHealthy?: boolean;
}

function recoveryStepsFor(
    phase: Exclude<TxPhase, "idle" | "success"> | undefined,
    walletConnected: boolean,
    networkHealthy: boolean,
): string[] {
    const steps: string[] = [];
    if (!walletConnected) {
        steps.push("Reconnect your wallet, then retry the transaction.");
    }
    if (!networkHealthy) {
        steps.push("Switch RPC endpoint or wait for network stability before retrying.");
    }

    switch (phase) {
        case "building":
            steps.push("Refresh vault/route data and rebuild the transaction.");
            break;
        case "simulating":
            steps.push("Lower amount or increase slippage and simulate again.");
            break;
        case "waiting_for_wallet":
            steps.push("Open wallet extension and approve the pending request.");
            break;
        case "submitting":
            steps.push("Retry submission with a fresh signature and sufficient fee balance.");
            break;
        case "polling":
            steps.push("Wait for finality, then check explorer status before resubmitting.");
            break;
        case "failure":
            steps.push("Review the detailed error log to choose the next safe action.");
            break;
        default:
            steps.push("Retry once; if it still fails, copy details and contact support.");
            break;
    }

    return [...new Set(steps)].slice(0, 4);
}

/**
 * TransactionFailedModal
 *
 * Renders a modal overlay that shows a human-readable transaction failure
 * message and optionally reveals the raw developer logs.
 */
export default function TransactionFailedModal({
    error,
    onClose,
    onRetry,
    onViewDetails,
    failurePhase,
    walletConnected = true,
    networkHealthy = true,
}: TransactionFailedModalProps) {
    const [showRaw, setShowRaw] = useState(false);
    const [copied, setCopied] = useState(false);

    const recoverySteps = recoveryStepsFor(failurePhase, walletConnected, networkHealthy);

    async function copyDetails() {
        const payload = buildRedactedCopyPayload({
            title: error.title,
            code: error.code,
            phase: failurePhase,
            message: error.message,
            suggestion: error.suggestion,
            raw: error.raw,
            walletConnected,
            networkHealthy,
        });
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
            } else {
                const ta = document.createElement("textarea");
                ta.value = payload;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch {
            setCopied(false);
        }
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="tx-fail-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-4"
        >
            <div className="relative w-full max-w-xl rounded-2xl bg-gray-900 border border-red-500/40 shadow-2xl shadow-red-900/30 p-4 sm:p-6 space-y-4">
                {/* Close button */}
                <button
                    onClick={onClose}
                    aria-label="Close"
                    className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
                >
                    <X size={20} />
                </button>

                {/* Header */}
                <div className="flex items-center gap-3">
                    <span className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                        <AlertTriangle size={20} className="text-red-400" />
                    </span>
                    <div>
                        <h2
                            id="tx-fail-title"
                            className="text-lg font-bold text-white"
                        >
                            {error.title}
                        </h2>
                        {error.code !== undefined && (
                            <span className="text-xs text-gray-500 font-mono">
                                Error code {error.code}
                            </span>
                        )}
                    </div>
                </div>

                {/* User-friendly message */}
                <p className="text-gray-300 text-sm leading-relaxed">{error.message}</p>

                {/* Suggested fix */}
                <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 px-4 py-3 text-sm text-indigo-300">
                    <span className="font-semibold text-indigo-200">Suggested fix: </span>
                    {error.suggestion}
                </div>

                <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
                    <p className="text-sm font-semibold text-white mb-2">Recovery steps</p>
                    <ul className="space-y-1 text-sm text-gray-300 list-disc pl-5">
                        {recoverySteps.map((step) => (
                            <li key={step}>{step}</li>
                        ))}
                    </ul>
                </div>

                {/* Expandable raw log */}
                <div>
                    <button
                        onClick={() => setShowRaw((p) => !p)}
                        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                    >
                        {showRaw ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {showRaw ? "Hide" : "Show"} developer log
                    </button>

                    {showRaw && (
                        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/60 border border-gray-700 p-3 text-xs text-gray-400 font-mono whitespace-pre-wrap break-all">
                            {error.raw}
                        </pre>
                    )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {onRetry && (
                        <button
                            onClick={onRetry}
                            className="inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all active:scale-95"
                        >
                            <RotateCcw size={14} />
                            Retry
                        </button>
                    )}
                    <button
                        onClick={copyDetails}
                        className="inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold transition-all active:scale-95"
                    >
                        <Copy size={14} />
                        {copied ? "Copied" : "Copy details"}
                    </button>
                    {onViewDetails && (
                        <button
                            onClick={onViewDetails}
                            className="py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-white text-sm font-semibold transition-all active:scale-95"
                        >
                            View details
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold transition-all active:scale-95"
                    >
                        Dismiss
                    </button>
                </div>
            </div>
        </div>
    );
}
