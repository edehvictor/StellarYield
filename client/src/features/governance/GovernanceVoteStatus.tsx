/**
 * GovernanceVoteStatus (#1190)
 *
 * Displays the reconciliation status of a submitted governance vote.
 * Handles pending, recorded, delayed, and failed states.
 */
import React, { useEffect, useState, useCallback } from "react";
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

  const fetchReceipt = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/governance/vote-receipts/${receiptId}`));
      if (!res.ok) {
        if (res.status === 404) {
          setFetchError("Vote receipt not found.");
        } else {
          setFetchError("Unable to load vote status.");
        }
        return;
      }
      const data: VoteReceipt = await res.json();
      setReceipt(data);
      setFetchError(null);
    } catch {
      setFetchError("Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    void fetchReceipt();

    if (pollIntervalMs <= 0) return;

    const interval = setInterval(() => {
      void fetchReceipt();
    }, pollIntervalMs);

    return () => clearInterval(interval);
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

  if (fetchError) {
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

      {(receipt.status === "pending" || receipt.status === "delayed") && (
        <button
          type="button"
          className="mt-1 flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors self-start"
          onClick={() => void fetchReceipt()}
          aria-label="Refresh vote status"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" />
          Refresh
        </button>
      )}
    </div>
  );
}

export default GovernanceVoteStatus;
