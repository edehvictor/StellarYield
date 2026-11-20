/**
 * GovernanceVoteStatus (#1190)
 *
 * Displays the reconciliation status of a submitted governance vote.
 * Handles pending, recorded, delayed, and failed states.
 *
 * Concurrency (#1895): polling, the Refresh button and a changing `receiptId`
 * can all start requests that finish out of order. Only one request runs at a
 * time, a response is applied only if it is still for the shown receipt, and a
 * response older than what is already displayed (see {@link isStaleReceipt})
 * is dropped, so a slow or lagging reply can never move a vote back from
 * "recorded" to "pending". A failed refresh keeps the last known receipt.
 */
import React, { useEffect, useState, useCallback, useRef } from "react";
import { CheckCircle2, Clock, AlertTriangle, XCircle, RefreshCw } from "lucide-react";
import { apiUrl } from "../../lib/api";

export type VoteReceiptStatus = "pending" | "recorded" | "delayed" | "failed";

export interface VoteReceipt {
  receiptId: string;
  proposalId: string;
  voter: string;
  choice: string;
  submittedAt: string;
  status: VoteReceiptStatus;
  recordedAt?: string;
  failureReason?: string;
  reconciliationAttempts: number;
  lastCheckedAt?: string;
}

/** Order of the lifecycle: pending → delayed → recorded | failed (final). */
const STATUS_RANK: Record<VoteReceiptStatus, number> = {
  pending: 0,
  delayed: 1,
  recorded: 2,
  failed: 2,
};

/**
 * True when `incoming` describes an earlier point in the vote's life than
 * `current`, so applying it would show out-of-date state. A receipt only ever
 * moves forward on the server, so an earlier-looking reply is a stale one.
 * A final status (recorded or failed) is never replaced by a different one.
 */
export function isStaleReceipt(current: VoteReceipt | null, incoming: VoteReceipt): boolean {
  if (!current || current.receiptId !== incoming.receiptId) return false;
  const from = STATUS_RANK[current.status];
  const to = STATUS_RANK[incoming.status];
  if (to < from) return true;
  if (from === 2 && current.status !== incoming.status) return true;
  return incoming.reconciliationAttempts < current.reconciliationAttempts;
}

interface GovernanceVoteStatusProps {
  receiptId: string;
  /** Poll interval in ms. Set to 0 to disable auto-refresh. Default: 15s */
  pollIntervalMs?: number;
}

const STATUS_CONFIG: Record<
  VoteReceiptStatus,
  { label: string; icon: React.ReactNode; colorClass: string; bgClass: string }
> = {
  pending: {
    label: "Pending confirmation",
    icon: <Clock className="w-4 h-4" aria-hidden="true" />,
    colorClass: "text-yellow-400",
    bgClass: "bg-yellow-400/10 border-yellow-400/30",
  },
  recorded: {
    label: "Vote recorded on-chain",
    icon: <CheckCircle2 className="w-4 h-4" aria-hidden="true" />,
    colorClass: "text-green-400",
    bgClass: "bg-green-400/10 border-green-400/30",
  },
  delayed: {
    label: "Indexing delayed — still waiting",
    icon: <AlertTriangle className="w-4 h-4" aria-hidden="true" />,
    colorClass: "text-orange-400",
    bgClass: "bg-orange-400/10 border-orange-400/30",
  },
  failed: {
    label: "Reconciliation failed",
    icon: <XCircle className="w-4 h-4" aria-hidden="true" />,
    colorClass: "text-red-400",
    bgClass: "bg-red-400/10 border-red-400/30",
  },
};

export function GovernanceVoteStatus({
  receiptId,
  pollIntervalMs = 15_000,
}: GovernanceVoteStatusProps) {
  const [receipt, setReceipt] = useState<VoteReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const receiptRef = useRef<VoteReceipt | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);

  const fetchReceipt = useCallback(async () => {
    // One request at a time: a poll tick or a click while one is running
    // would only race it.
    if (inFlightRef.current) return;
    const controller = new AbortController();
    inFlightRef.current = controller;
    setRefreshing(true);

    // Applied only while this request is still the live one for this receipt.
    const isCurrent = () => inFlightRef.current === controller && !controller.signal.aborted;

    try {
      const res = await fetch(apiUrl(`/api/governance/vote-receipts/${receiptId}`), {
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!res.ok) {
        // Keep showing what we already know on a failed refresh; only a
        // receipt that is gone, or was never loaded, replaces the view.
        if (res.status === 404) {
          receiptRef.current = null;
          setReceipt(null);
          setFetchError("Vote receipt not found.");
        } else {
          setFetchError("Unable to load vote status.");
        }
        return;
      }
      const data: VoteReceipt = await res.json();
      if (!isCurrent()) return;
      if (isStaleReceipt(receiptRef.current, data)) return;
      receiptRef.current = data;
      setReceipt(data);
      setFetchError(null);
    } catch {
      if (!isCurrent()) return;
      setFetchError("Unable to reach the server.");
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [receiptId]);

  useEffect(() => {
    // A different receipt starts from a clean slate; nothing from the previous
    // one may be shown for it, and its request must not land here.
    receiptRef.current = null;
    setReceipt(null);
    setFetchError(null);
    setLoading(true);
    void fetchReceipt();

    const interval =
      pollIntervalMs > 0
        ? setInterval(() => {
            void fetchReceipt();
          }, pollIntervalMs)
        : null;

    return () => {
      if (interval) clearInterval(interval);
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      setRefreshing(false);
    };
  }, [fetchReceipt, pollIntervalMs]);

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 text-gray-400 text-sm py-2"
        role="status"
        aria-live="polite"
        aria-label="Loading vote status"
      >
        <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
        <span>Checking vote status…</span>
      </div>
    );
  }

  if (fetchError && !receipt) {
    return (
      <div
        className="flex items-center gap-2 text-red-400 text-sm py-2"
        role="alert"
        aria-label="Error loading vote status"
      >
        <AlertTriangle className="w-4 h-4" aria-hidden="true" />
        <span>{fetchError}</span>
      </div>
    );
  }

  if (!receipt) return null;

  const config = STATUS_CONFIG[receipt.status];

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm ${config.bgClass}`}
      role="status"
      aria-live="polite"
      aria-label={`Vote status: ${config.label}`}
    >
      <div className={`flex items-center gap-2 font-medium ${config.colorClass}`}>
        {config.icon}
        <span>{config.label}</span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-gray-400">
        <dt className="font-medium text-gray-500">Proposal</dt>
        <dd className="truncate">{receipt.proposalId}</dd>

        <dt className="font-medium text-gray-500">Choice</dt>
        <dd className="capitalize">{receipt.choice}</dd>

        <dt className="font-medium text-gray-500">Submitted</dt>
        <dd>{new Date(receipt.submittedAt).toLocaleString()}</dd>

        {receipt.status === "recorded" && receipt.recordedAt && (
          <>
            <dt className="font-medium text-gray-500">Recorded at</dt>
            <dd>{new Date(receipt.recordedAt).toLocaleString()}</dd>
          </>
        )}

        {receipt.status === "failed" && receipt.failureReason && (
          <>
            <dt className="font-medium text-gray-500">Reason</dt>
            <dd className="text-red-300">{receipt.failureReason}</dd>
          </>
        )}
      </dl>

      {fetchError && (
        <p className="flex items-center gap-1 text-xs text-orange-300" role="alert">
          <AlertTriangle className="w-3 h-3" aria-hidden="true" />
          {fetchError} Showing the last known status.
        </p>
      )}

      {(receipt.status === "pending" || receipt.status === "delayed") && (
        <button
          type="button"
          className="mt-1 flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors self-start disabled:opacity-50"
          onClick={() => void fetchReceipt()}
          disabled={refreshing}
          aria-busy={refreshing}
          aria-label="Refresh vote status"
        >
          <RefreshCw
            className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      )}
    </div>
  );
}

export default GovernanceVoteStatus;
