/**
 * TransactionErrorBoundary (#1336)
 *
 * Isolates render-time failures inside a single transaction workflow (deposit,
 * withdraw, zap, governance execute, …) so a crashing step degrades to a
 * contained recovery panel instead of blanking the whole route.
 *
 * It is intentionally narrower than `RouteBoundary`: the fallback keeps the
 * surrounding page mounted (vault stats, action tabs, wallet state) and names
 * the workflow that failed. Failures are reported through
 * `logTransactionFailure` with a stable per-failure correlation id that is also
 * shown to the user, and the raw details can be copied in redacted form.
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { AlertTriangle, Copy, RotateCcw } from "lucide-react";
import { logTransactionFailure } from "../../utils/diagnostics";
import { buildRedactedCopyPayload } from "../../utils/redactClient";

export interface TransactionErrorBoundaryProps {
  children: ReactNode;
  /** Transaction workflow this boundary protects, e.g. "deposit" | "withdraw". */
  workflowName: string;
  /**
   * Optional side effect invoked alongside diagnostics, e.g. to clear a
   * transaction draft when the workflow could not be rendered.
   */
  onError?: (error: Error, errorId: string) => void;
}

interface TransactionErrorBoundaryState {
  error: Error | null;
  errorId: string | null;
  copied: boolean;
}

/**
 * Correlates a boundary failure with a support ticket / server log line.
 * Prefers `crypto.randomUUID` and falls back to Math.random in older runtimes.
 */
export function createTransactionErrorId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `tx-${random.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Catches render errors thrown by a transaction workflow subtree and renders a
 * recovery panel that surfaces the real error — it never swallows it silently.
 */
export class TransactionErrorBoundary extends Component<
  TransactionErrorBoundaryProps,
  TransactionErrorBoundaryState
> {
  state: TransactionErrorBoundaryState = {
    error: null,
    errorId: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): Partial<TransactionErrorBoundaryState> {
    return { error, errorId: createTransactionErrorId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const { workflowName, onError } = this.props;
    const errorId = this.state.errorId ?? createTransactionErrorId();

    // Structured diagnostics so monitoring tools can index workflow + error id.
    logTransactionFailure({ workflowName, errorId, error });

    // Legacy console output so the component stack is still visible in DevTools.
    console.error("[TransactionErrorBoundary] render error:", error, info.componentStack);

    onError?.(error, errorId);
  }

  /** Re-try rendering the workflow without reloading the page. */
  private handleRetry = () => {
    this.setState({ error: null, errorId: null, copied: false });
  };

  /** Copy a redacted summary the user can share with support. */
  private handleCopy = async () => {
    const { error, errorId } = this.state;
    if (!error) return;

    const payload = buildRedactedCopyPayload({
      title: `Transaction workflow "${this.props.workflowName}" failed to render`,
      message: error.message,
      suggestion: "Retry the step; if it fails again, share these details with support.",
      raw: `errorId=${errorId ?? "unknown"}\n${error.stack ?? error.message}`,
    });

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = payload;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 1400);
    } catch {
      this.setState({ copied: false });
    }
  };

  render(): ReactNode {
    const { error, errorId, copied } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        aria-live="assertive"
        data-testid="transaction-error-boundary"
        className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-300"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={18} className="text-red-400 shrink-0" />
          <p className="font-semibold text-red-200">
            The {this.props.workflowName} step could not be displayed.
          </p>
        </div>

        <p className="mt-1 text-xs text-red-400/80">
          <span className="font-mono">{this.props.workflowName}</span>
          {errorId && (
            <>
              {" "}
              · reference: <span className="font-mono">{errorId}</span>
            </>
          )}
        </p>

        {/* The real error message is surfaced, never swallowed. */}
        <p className="mt-2 break-words font-mono text-xs text-red-300/90">{error.message}</p>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={this.handleRetry}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-1.5 text-red-100 transition-colors hover:bg-red-500/30"
          >
            <RotateCcw size={14} />
            Try again
          </button>
          <button
            type="button"
            onClick={this.handleCopy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-transparent px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/10"
          >
            <Copy size={14} />
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
      </div>
    );
  }
}

export default TransactionErrorBoundary;
