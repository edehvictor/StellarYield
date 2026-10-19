import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, Download, Loader2, ScrollText } from "lucide-react";
import {
  EMPTY_AUDIT_FILTER_FORM,
  AUDIT_PAGE_SIZE,
  describeActiveAuditFilters,
  hasActiveAuditFilters,
  hasFormErrors,
  validateAuditFilterForm,
  type AuditLogFilterForm,
} from "./auditLogFilters";
import {
  AuditLogRequestError,
  exportAuditLogsCsv,
  fetchAuditLogPage,
  type AuditLogEntryDto,
} from "./auditLogService";

export interface AuditLogPanelProps {
  /**
   * Admin bearer token. When omitted the panel shows a token field; the token
   * is held in memory only and never persisted.
   */
  authToken?: string;
}

type LoadStatus = "loading" | "loaded" | "error";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toRequestError(error: unknown): AuditLogRequestError {
  return error instanceof AuditLogRequestError
    ? error
    : new AuditLogRequestError("UNAVAILABLE");
}

function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default function AuditLogPanel({ authToken: authTokenProp }: AuditLogPanelProps) {
  const [form, setForm] = useState<AuditLogFilterForm>(EMPTY_AUDIT_FILTER_FORM);
  const [applied, setApplied] = useState<AuditLogFilterForm>(EMPTY_AUDIT_FILTER_FORM);
  const [tokenInput, setTokenInput] = useState("");

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<AuditLogRequestError | null>(null);
  const [entries, setEntries] = useState<AuditLogEntryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);

  const authToken = authTokenProp ?? (tokenInput.trim() || undefined);
  const formErrors = validateAuditFilterForm(form);
  const invalid = hasFormErrors(formErrors);

  /** Load the first page for `filters`, superseding any request in flight. */
  const loadFirstPage = useCallback(
    async (filters: AuditLogFilterForm) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setStatus("loading");
      setError(null);
      setLoadMoreError(null);
      setExportNotice(null);
      try {
        const page = await fetchAuditLogPage(filters, {
          authToken,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setStatus("loaded");
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        setEntries([]);
        setNextCursor(null);
        setHasMore(false);
        setError(toRequestError(err));
        setStatus("error");
      }
    },
    [authToken],
  );

  // Initial, unfiltered load. Later loads are driven by Apply / Clear / Retry.
  useEffect(() => {
    void loadFirstPage(EMPTY_AUDIT_FILTER_FORM);
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    setApplied(form);
    void loadFirstPage(form);
  };

  const clearFilters = () => {
    setForm(EMPTY_AUDIT_FILTER_FORM);
    setApplied(EMPTY_AUDIT_FILTER_FORM);
    void loadFirstPage(EMPTY_AUDIT_FILTER_FORM);
  };

  const loadMore = async () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    const controller = controllerRef.current ?? new AbortController();
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchAuditLogPage(applied, {
        authToken,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setEntries((current) => [...current, ...page.entries]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      if (isAbortError(err)) return;
      // Keep the rows already on screen; report the failure next to the button.
      setLoadMoreError(toRequestError(err).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    if (invalid || exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const result = await exportAuditLogsCsv(applied, { authToken });
      downloadCsv(result.csv, "audit-logs.csv");
      setExportNotice(
        result.truncated
          ? "Export truncated at the server row limit. Narrow the filters to export the rest."
          : "Export downloaded.",
      );
    } catch (err) {
      setExportNotice(toRequestError(err).message);
    } finally {
      setExporting(false);
    }
  };

  const filtered = hasActiveAuditFilters(applied);
  const chips = describeActiveAuditFilters(applied);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-3xl font-extrabold tracking-tight flex items-center gap-3">
          <ScrollText size={28} className="text-indigo-400" />
          Audit log
        </h2>
        <p className="text-gray-400 mt-1">
          Signed record of admin actions. Filter by wallet, action and date range.
        </p>
      </header>

      <form
        onSubmit={applyFilters}
        aria-label="Audit log filters"
        className="grid gap-4 md:grid-cols-2 rounded-xl border border-white/10 bg-white/5 p-4"
      >
        <div className="md:col-span-2">
          <label htmlFor="audit-wallet" className="block text-sm text-gray-300 mb-1">
            Wallet address
          </label>
          <input
            id="audit-wallet"
            type="text"
            value={form.wallet}
            onChange={(e) => setForm({ ...form, wallet: e.target.value })}
            placeholder="G…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={formErrors.wallet ? true : undefined}
            aria-describedby={formErrors.wallet ? "audit-wallet-error" : undefined}
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 font-mono text-sm"
          />
          {formErrors.wallet && (
            <p id="audit-wallet-error" role="alert" className="mt-1 text-sm text-red-300">
              {formErrors.wallet}
            </p>
          )}
        </div>

        <div className="md:col-span-2">
          <label htmlFor="audit-actions" className="block text-sm text-gray-300 mb-1">
            Actions (comma-separated)
          </label>
          <input
            id="audit-actions"
            type="text"
            value={form.actions}
            onChange={(e) => setForm({ ...form, actions: e.target.value })}
            placeholder="ADMIN_ACTION_CONFIRMED, UPDATE_VAULT_PARAMETERS"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={formErrors.actions ? true : undefined}
            aria-describedby={formErrors.actions ? "audit-actions-error" : undefined}
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm"
          />
          {formErrors.actions && (
            <p id="audit-actions-error" role="alert" className="mt-1 text-sm text-red-300">
              {formErrors.actions}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="audit-start" className="block text-sm text-gray-300 mb-1">
            Start date
          </label>
          <input
            id="audit-start"
            type="date"
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            aria-invalid={formErrors.startDate ? true : undefined}
            aria-describedby={formErrors.startDate ? "audit-start-error" : undefined}
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm"
          />
          {formErrors.startDate && (
            <p id="audit-start-error" role="alert" className="mt-1 text-sm text-red-300">
              {formErrors.startDate}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="audit-end" className="block text-sm text-gray-300 mb-1">
            End date
          </label>
          <input
            id="audit-end"
            type="date"
            value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            aria-invalid={formErrors.endDate ? true : undefined}
            aria-describedby={formErrors.endDate ? "audit-end-error" : undefined}
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm"
          />
          {formErrors.endDate && (
            <p id="audit-end-error" role="alert" className="mt-1 text-sm text-red-300">
              {formErrors.endDate}
            </p>
          )}
        </div>

        {authTokenProp === undefined && (
          <div className="md:col-span-2">
            <label htmlFor="audit-token" className="block text-sm text-gray-300 mb-1">
              Admin access token
            </label>
            <input
              id="audit-token"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="off"
              className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">Kept in memory only; never stored.</p>
          </div>
        )}

        <div className="md:col-span-2 flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={invalid}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Apply filters
          </button>
          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasActiveAuditFilters(form) && !filtered}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm disabled:opacity-50"
          >
            Clear filters
          </button>
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={invalid || exporting}
            className="ml-auto inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm disabled:opacity-50"
          >
            {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            Export CSV
          </button>
        </div>
      </form>

      {chips.length > 0 && (
        <ul aria-label="Applied filters" className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <li key={chip} className="rounded-full bg-indigo-500/20 px-3 py-1 text-xs text-indigo-200">
              {chip}
            </li>
          ))}
        </ul>
      )}

      {exportNotice && (
        <p role="status" className="text-sm text-gray-300">
          {exportNotice}
        </p>
      )}

      {status === "loading" && (
        <div aria-busy="true" className="flex items-center gap-2 py-8 text-gray-400">
          <Loader2 size={20} className="animate-spin" />
          Loading audit log…
        </div>
      )}

      {status === "error" && error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="space-y-2">
            <p>{error.message}</p>
            {error.code === "UNAVAILABLE" && (
              <button
                type="button"
                onClick={() => void loadFirstPage(applied)}
                className="rounded border border-red-400/40 px-3 py-1"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {status === "loaded" && entries.length === 0 && (
        <p className="py-8 text-center text-gray-400">
          {filtered
            ? "No audit entries match these filters."
            : "No audit entries have been recorded yet."}
        </p>
      )}

      {status === "loaded" && entries.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Audit log entries, newest first ({entries.length} shown)
            </caption>
            <thead className="bg-white/5 text-gray-400">
              <tr>
                <th scope="col" className="px-3 py-2">Time</th>
                <th scope="col" className="px-3 py-2">Action</th>
                <th scope="col" className="px-3 py-2">Actor</th>
                <th scope="col" className="px-3 py-2">Resource</th>
                <th scope="col" className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t border-white/5">
                  <td className="px-3 py-2 whitespace-nowrap">{formatTimestamp(entry.timestamp)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{entry.action}</td>
                  <td className="px-3 py-2 font-mono text-xs break-all">{entry.userId}</td>
                  <td className="px-3 py-2">
                    {entry.resource}
                    {entry.resourceId ? (
                      <span className="block font-mono text-xs text-gray-400 break-all">
                        {entry.resourceId}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{entry.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status === "loaded" && loadMoreError && (
        <p role="alert" className="text-center text-sm text-red-300">
          {loadMoreError}
        </p>
      )}

      {status === "loaded" && hasMore && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : `Load ${AUDIT_PAGE_SIZE} more`}
          </button>
        </div>
      )}
    </div>
  );
}
