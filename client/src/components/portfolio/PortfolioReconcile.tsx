import React, { useState, useMemo, useCallback } from "react";
import {
  AlertTriangle,
  Copy,
  Check,
  Filter,
  ChevronDown,
  ChevronRight,
  FileText,
  ExternalLink,
} from "lucide-react";
import "./PortfolioReconcile.css";

export type ReconcileAnomalyType = "missing" | "duplicate" | "stale" | "orphaned" | "matched";

export type ReconcileStatus = "confirmed" | "pending" | "unverified";

export interface ReconcileEvidence {
  /** Ledger sequence number */
  ledger?: number;
  /** Transaction hash */
  txHash?: string;
  /** Vault identifier */
  vault?: string;
  /** Anomaly identifier */
  anomalyId?: string;
  /** Projection version used for comparison */
  projectionVersion?: string;
  /** Event source identifier */
  sourceEventId?: string;
  /** Whether the checkpoint is stale */
  isStaleCheckpoint?: boolean;
}

export interface ReconcileRow {
  asset: string;
  vault: string;
  expected: string | number;
  observed: string | number | null;
  delta: string | number | null;
  severity: "ok" | "warning" | "critical";
  anomalyType: ReconcileAnomalyType;
  status: ReconcileStatus;
  evidence?: ReconcileEvidence;
}

export interface ReconcileGroup {
  vault: string;
  rows: ReconcileRow[];
}

export type DepositReceiptStatus = 'pending' | 'confirmed' | 'mismatched';

export interface DepositReceiptRow {
  txHash: string;
  assetId: string;
  amount: number;
  status: DepositReceiptStatus;
  sharesAssigned?: number;
  mismatchReason?: string;
}

type Props = {
  rows: ReconcileRow[];
  receipts?: DepositReceiptRow[];
};

const RECEIPT_STATUS_LABELS: Record<DepositReceiptStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  mismatched: 'Mismatch',
};

const RECEIPT_STATUS_CLASSES: Record<DepositReceiptStatus, string> = {
  pending: 'sev-warning',
  confirmed: 'sev-ok',
  mismatched: 'sev-critical',
};

export const PortfolioReconcile: React.FC<Props> = ({ rows, receipts }) => {
  return (
    <div className="portfolio-reconcile">
      <table>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Expected</th>
            <th>Observed</th>
            <th>Delta</th>
            <th>Severity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.asset} className={`sev-${r.severity}`}>
              <td>{r.asset}</td>
              <td>{r.expected}</td>
              <td>{r.observed === null ? '—' : r.observed}</td>
              <td>{r.delta === null ? '—' : r.delta}</td>
              <td>{r.severity}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {receipts && receipts.length > 0 && (
        <>
          <h3 className="receipt-section-title">Deposit Receipts</h3>
          <table className="receipt-table">
            <thead>
              <tr>
                <th>Tx Hash</th>
                <th>Asset</th>
                <th>Amount</th>
                <th>Shares</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr
                  key={r.txHash}
                  className={RECEIPT_STATUS_CLASSES[r.status]}
                  data-testid={`receipt-${r.txHash}`}
                >
                  <td title={r.txHash}>{r.txHash.slice(0, 8)}...</td>
                  <td>{r.assetId}</td>
                  <td>{r.amount}</td>
                  <td>{r.sharesAssigned ?? '—'}</td>
                  <td>{RECEIPT_STATUS_LABELS[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
function groupByVault(rows: ReconcileRow[]): ReconcileGroup[] {
  const map = new Map<string, ReconcileRow[]>();
  for (const row of rows) {
    const key = row.vault ?? "Unknown";
    const group = map.get(key) ?? [];
    group.push(row);
    map.set(key, group);
  }
  return Array.from(map.entries()).map(([vault, groupRows]) => ({
    vault,
    rows: groupRows,
  }));
}

function formatEvidence(evidence: ReconcileEvidence): string {
  const parts: string[] = [];
  if (evidence.vault) parts.push(`Vault: ${evidence.vault}`);
  if (evidence.anomalyId) parts.push(`Anomaly: ${evidence.anomalyId}`);
  if (evidence.ledger) parts.push(`Ledger: ${evidence.ledger}`);
  if (evidence.txHash) parts.push(`TX: ${evidence.txHash}`);
  if (evidence.projectionVersion) parts.push(`Projection: ${evidence.projectionVersion}`);
  if (evidence.sourceEventId) parts.push(`Event: ${evidence.sourceEventId}`);
  return parts.join(" | ");
}

function copyEvidence(row: ReconcileRow): string {
  const evidence = row.evidence ?? {};
  const lines = [
    `Asset: ${row.asset}`,
    `Vault: ${row.vault}`,
    `Anomaly: ${row.anomalyType}`,
    `Severity: ${row.severity}`,
    `Status: ${row.status}`,
    `Expected: ${row.expected}`,
    `Observed: ${row.observed === null ? "N/A" : row.observed}`,
    `Delta: ${row.delta === null ? "N/A" : row.delta}`,
  ];
  if (evidence.ledger) lines.push(`Ledger: ${evidence.ledger}`);
  if (evidence.txHash) lines.push(`TX Hash: ${evidence.txHash}`);
  if (evidence.anomalyId) lines.push(`Anomaly ID: ${evidence.anomalyId}`);
  if (evidence.projectionVersion) lines.push(`Projection: ${evidence.projectionVersion}`);
  if (evidence.sourceEventId) lines.push(`Source Event: ${evidence.sourceEventId}`);
  return lines.join("\n");
}

const SEVERITY_LABELS: Record<string, string> = {
  ok: "Matched",
  warning: "Warning",
  critical: "Critical",
};

const ANOMALY_LABELS: Record<ReconcileAnomalyType, string> = {
  matched: "Matched",
  missing: "Missing",
  duplicate: "Duplicate",
  stale: "Stale",
  orphaned: "Orphaned",
};

export const PortfolioReconcile: React.FC<Props> = ({ rows }) => {
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showStaleOnly, setShowStaleOnly] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (severityFilter !== "all" && row.severity !== severityFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (showStaleOnly && !row.evidence?.isStaleCheckpoint) return false;
      return true;
    });
  }, [rows, severityFilter, statusFilter, showStaleOnly]);

  const groups = useMemo(() => groupByVault(filteredRows), [filteredRows]);

  const toggleGroup = useCallback((vault: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(vault)) next.delete(vault);
      else next.add(vault);
      return next;
    });
  }, []);

  const copyToClipboard = useCallback(async (row: ReconcileRow, id: string) => {
    const text = copyEvidence(row);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  }, []);

  if (rows.length === 0) {
    return (
      <div className="portfolio-reconcile">
        <div className="reconcile-empty">
          <FileText size={32} className="text-gray-500 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No reconciliation data</p>
          <p className="text-gray-600 text-sm mt-1">
            Reconciliation differences will appear here once data is available.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="portfolio-reconcile">
      {/* Filters */}
      <div className="reconcile-filters">
        <div className="filter-group">
          <Filter size={14} className="text-gray-400" />
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="filter-select"
            aria-label="Filter by severity"
          >
            <option value="all">All Severity</option>
            <option value="ok">Matched</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="filter-group">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="filter-select"
            aria-label="Filter by status"
          >
            <option value="all">All Status</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="unverified">Unverified</option>
          </select>
        </div>
        <label className="filter-checkbox">
          <input
            type="checkbox"
            checked={showStaleOnly}
            onChange={(e) => setShowStaleOnly(e.target.checked)}
          />
          Stale checkpoints only
        </label>
        <span className="filter-count">
          {filteredRows.length} of {rows.length} items
        </span>
      </div>

      {/* Groups */}
      {groups.length === 0 && (
        <div className="reconcile-empty">
          <p className="text-gray-400">No items match the current filters.</p>
        </div>
      )}

      {groups.map((group) => (
        <div key={group.vault} className="reconcile-group">
          <button
            type="button"
            className="group-header"
            onClick={() => toggleGroup(group.vault)}
            aria-expanded={expandedGroups.has(group.vault)}
          >
            {expandedGroups.has(group.vault) ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
            <span className="group-vault">{group.vault}</span>
            <span className="group-count">{group.rows.length} items</span>
            {group.rows.some((r) => r.severity === "critical") && (
              <AlertTriangle size={14} className="text-red-400" />
            )}
          </button>

          {expandedGroups.has(group.vault) && (
            <table className="reconcile-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Expected</th>
                  <th>Observed</th>
                  <th>Delta</th>
                  <th>Severity</th>
                  <th>Anomaly</th>
                  <th>Status</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((r, idx) => {
                  const rowId = `${group.vault}-${r.asset}-${idx}`;
                  return (
                    <tr key={rowId} className={`sev-${r.severity}`}>
                      <td>{r.asset}</td>
                      <td>{r.expected}</td>
                      <td>{r.observed === null ? "—" : r.observed}</td>
                      <td>{r.delta === null ? "—" : r.delta}</td>
                      <td>{SEVERITY_LABELS[r.severity] ?? r.severity}</td>
                      <td>{ANOMALY_LABELS[r.anomalyType]}</td>
                      <td>{r.status}</td>
                      <td>
                        {r.evidence && (
                          <div className="evidence-cell">
                            <span className="evidence-text" title={formatEvidence(r.evidence)}>
                              {r.evidence.ledger && <span className="evidence-tag">L{r.evidence.ledger}</span>}
                              {r.evidence.txHash && <span className="evidence-tag">{r.evidence.txHash.slice(0, 8)}…</span>}
                              {r.evidence.isStaleCheckpoint && <span className="evidence-stale">stale</span>}
                            </span>
                            <button
                              type="button"
                              className="copy-btn"
                              onClick={() => void copyToClipboard(r, rowId)}
                              title="Copy evidence to clipboard"
                              aria-label={`Copy reconciliation evidence for ${r.asset}`}
                            >
                              {copiedId === rowId ? (
                                <Check size={12} className="text-green-400" />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
};

export default PortfolioReconcile;
