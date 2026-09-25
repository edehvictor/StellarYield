import { Component, Suspense } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  classifyRouteFailure,
  logRouteFailure,
} from "../../utils/diagnostics";
import type { RouteFailureType } from "../../utils/diagnostics";
import { openDiagnosticsPanel } from "../../lib/config";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Human-readable route identifier used in diagnostic logs (e.g. "analytics", "treasury"). */
  routeName?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  failureType: RouteFailureType | null;
  /** Whether a chunk-load retry has already been attempted (avoids infinite loops). */
  chunkRetryAttempted: boolean;
}

/**
 * Catches render/load errors from a route subtree and shows a fallback panel
 * that surfaces the real error — it never swallows errors silently.
 *
 * For chunk-load failures (dynamic-import / code-splitting) it offers a
 * targeted retry that reloads the page so the browser can re-fetch the
 * missing chunk.  Render errors get a standard in-place retry instead.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    failureType: null,
    chunkRetryAttempted: false,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      error,
      failureType: classifyRouteFailure(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const routeName = this.props.routeName ?? "unknown";
    const failureType = classifyRouteFailure(error);

    // Emit structured diagnostics so monitoring tools can index by route + type.
    logRouteFailure({ routeName, failureType, error });

    // Legacy console output so the component stack is still visible in DevTools.
    console.error("[RouteBoundary] render error:", error, info.componentStack);
  }

  /** Re-try a render error without reloading the page. */
  private handleRenderRetry = () => {
    this.setState({ error: null, failureType: null, chunkRetryAttempted: false });
  };

  /**
   * Re-try a chunk-load error by reloading the page.
   *
   * A hard reload forces the browser to re-fetch all chunk scripts so a
   * transient CDN hiccup or stale cache entry doesn't block the user
   * permanently.  We only do this once per mount to avoid reload loops.
   */
  private handleChunkRetry = () => {
    if (this.state.chunkRetryAttempted) {
      // Already tried a reload — fall back to clearing state so the user at
      // least sees a fresh error panel rather than nothing.
      this.setState({ error: null, failureType: null });
      return;
    }
    this.setState({ chunkRetryAttempted: true }, () => {
      window.location.reload();
    });
  };

  render(): ReactNode {
    const { error, failureType } = this.state;

    if (error) {
      const isChunkError = failureType === "chunk_load_error";

      return (
        <div
          role="alert"
          aria-live="assertive"
          className="m-6 rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300"
        >
          <p className="font-semibold text-red-200">
            {isChunkError
              ? "Failed to load this page — the resource could not be fetched."
              : "Something went wrong loading this page."}
          </p>

          {/* Failure type badge */}
          <p className="mt-1 text-xs text-red-400/70">
            <span className="font-mono">{failureType}</span>
            {this.props.routeName && (
              <> &middot; route: <span className="font-mono">{this.props.routeName}</span></>
            )}
          </p>

          <p className="mt-2 break-words font-mono text-xs text-red-300/90">
            {error.message}
          </p>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={isChunkError ? this.handleChunkRetry : this.handleRenderRetry}
              className="rounded-lg bg-red-500/20 px-3 py-1.5 text-red-100 transition-colors hover:bg-red-500/30"
            >
              {isChunkError ? "Reload page" : "Try again"}
            </button>
            <button
              type="button"
              onClick={() => openDiagnosticsPanel()}
              className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-slate-300 transition-colors hover:bg-slate-700 text-xs font-medium"
            >
              Inspect Diagnostics
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/** Loading fallback shown while a lazily-loaded route is resolving. */
export function RouteLoadingPanel() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex items-center justify-center gap-3 p-12 text-slate-400"
    >
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-500 border-t-transparent" />
      <span className="text-sm">Loading…</span>
    </div>
  );
}

export interface RouteBoundaryProps {
  children: ReactNode;
  /**
   * Human-readable name for this route, forwarded to diagnostics on failure.
   * Defaults to "unknown" when omitted.
   * @example "analytics" | "treasury" | "governance" | "transparency"
   */
  routeName?: string;
}

/**
 * Route-level boundary: renders a loading panel while a lazy page loads, and an
 * error panel (surfacing the real error) if the page throws while loading or
 * rendering. Wrap analytics-heavy route elements with this.
 *
 * Pass `routeName` so diagnostics can identify which route failed.
 */
export function RouteBoundary({ children, routeName }: RouteBoundaryProps) {
  return (
    <ErrorBoundary routeName={routeName}>
      <Suspense fallback={<RouteLoadingPanel />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

export default RouteBoundary;
