/**
 * ApiErrorBanner
 *
 * A reusable error banner for API failures.
 * Supports retry, dismiss, and compact display variants.
 */
import { AlertCircle, RefreshCw, X } from "lucide-react";

export interface ApiErrorBannerProps {
    /** The error message to display. */
    message: string;
    /** If provided, a "Retry" button is shown that calls this on click. */
    onRetry?: () => void;
    /** If provided, a dismiss (×) button is shown that calls this on click. */
    onDismiss?: () => void;
    /**
     * Compact mode: renders a small inline pill rather than a full-width banner.
     * Useful inside dense UIs (e.g. PortfolioBuilder).
     */
    compact?: boolean;
    /** Extra Tailwind classes to merge onto the root element. */
    className?: string;
}

export default function ApiErrorBanner({
    message,
    onRetry,
    onDismiss,
    compact = false,
    className = "",
}: ApiErrorBannerProps) {
    if (!message) return null;

    if (compact) {
        return (
            <div
                role="alert"
                className={`flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm ${className}`}
            >
                <AlertCircle
                    className="text-red-400 shrink-0"
                    size={14}
                    aria-hidden="true"
                />
                <span className="text-red-400 truncate flex-1">{message}</span>
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        aria-label="Retry"
                        className="text-red-400 hover:text-red-300 transition-colors shrink-0"
                    >
                        <RefreshCw size={13} />
                    </button>
                )}
                {onDismiss && (
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label="Dismiss error"
                        className="text-red-400 hover:text-red-300 transition-colors shrink-0"
                    >
                        <X size={13} />
                    </button>
                )}
            </div>
        );
    }

    return (
        <div
            role="alert"
            className={`flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4 ${className}`}
        >
            <AlertCircle
                className="text-red-400 shrink-0 mt-0.5"
                size={18}
                aria-hidden="true"
            />
            <p className="text-red-400 text-sm flex-1">{message}</p>
            <div className="flex items-center gap-2 shrink-0">
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        aria-label="Retry"
                        className="flex items-center gap-1.5 text-xs font-semibold text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg px-2.5 py-1 transition-colors"
                    >
                        <RefreshCw size={12} />
                        Retry
                    </button>
                )}
                {onDismiss && (
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label="Dismiss error"
                        className="text-red-400 hover:text-red-300 transition-colors p-0.5"
                    >
                        <X size={15} />
                    </button>
                )}
            </div>
        </div>
    );
}
