/**
 * TransactionFailedModal.tsx
 *
 * Displays a user-friendly "Transaction Failed" overlay with a friendly
 * message, a suggested fix, and an expandable raw developer log.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, X } from "lucide-react";
import type { DecodedError } from "../../utils/errorDecoder";

interface TransactionFailedModalProps {
    /** Decoded error object from `decodeTransactionError`. */
    error: DecodedError;
    /** Called when the user dismisses the modal. */
    onClose: () => void;
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
}: TransactionFailedModalProps) {
    const [showRaw, setShowRaw] = useState(false);

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="tx-fail-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        >
            <div className="relative w-full max-w-md rounded-2xl bg-gray-900 border border-red-500/40 shadow-2xl shadow-red-900/30 p-6 space-y-4">
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

                {/* Dismiss */}
                <button
                    onClick={onClose}
                    className="w-full py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold transition-all active:scale-95"
                >
                    Dismiss
                </button>
            </div>
        </div>
    );
}
