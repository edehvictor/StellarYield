/**
 * APY Alerts Modal
 *
 * Allows users to create, view, and delete custom APY threshold alerts.
 * Alerts trigger an email when a vault's APY crosses the configured threshold.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Bell, Trash2, Plus, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { UserAlert, AlertCondition } from "./types";
import { fetchAlerts, createAlert, deleteAlert } from "./alertsApi";

const MAX_ALERTS = 20;

interface AlertsModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  /** Available vault IDs to select from */
  vaultOptions: string[];
}

interface FormState {
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: string;
  email: string;
}

const DEFAULT_FORM: FormState = {
  vaultId: "",
  condition: "above",
  thresholdValue: "",
  email: "",
};

export default function AlertsModal({
  isOpen,
  onClose,
  walletAddress,
  vaultOptions,
}: AlertsModalProps) {
  const [alerts, setAlerts] = useState<UserAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const loadAlerts = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    try {
      const data = await fetchAlerts(walletAddress);
      setAlerts(data);
    } catch {
      // silently fail — empty list shown
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (isOpen) void loadAlerts();
  }, [isOpen, loadAlerts]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const activeAlerts = alerts.filter((a) => a.status === "active");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (!form.vaultId) { setFormError("Select a vault"); return; }
    const threshold = parseFloat(form.thresholdValue);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1000) {
      setFormError("APY threshold must be between 0 and 1000");
      return;
    }
    if (!form.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setFormError("Enter a valid email address");
      return;
    }
    if (activeAlerts.length >= MAX_ALERTS) {
      setFormError(`Maximum of ${MAX_ALERTS} active alerts reached`);
      return;
    }

    setSubmitting(true);
    try {
      const created = await createAlert({
        walletAddress,
        vaultId: form.vaultId,
        condition: form.condition,
        thresholdValue: threshold,
        email: form.email,
      });
      setAlerts((prev) => [created, ...prev]);
      setForm(DEFAULT_FORM);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create alert");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteAlert(id, walletAddress);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="APY Alerts"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="glass-panel w-full max-w-md mx-4 p-6 rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Bell size={18} className="text-indigo-400" /> APY Alerts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close alerts"
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-gray-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Create form */}
        <form onSubmit={(e) => void handleSubmit(e)} className="mb-5 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <select
              value={form.vaultId}
              onChange={(e) => setForm((f) => ({ ...f, vaultId: e.target.value }))}
              aria-label="Select vault"
              className="col-span-2 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            >
              <option value="">Select vault…</option>
              {vaultOptions.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>

            <select
              value={form.condition}
              onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value as AlertCondition }))}
              aria-label="Alert condition"
              className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            >
              <option value="above">APY goes above</option>
              <option value="below">APY falls below</option>
            </select>

            <div className="flex items-center gap-1">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={1000}
                step={0.1}
                placeholder="10.0"
                value={form.thresholdValue}
                onChange={(e) => setForm((f) => ({ ...f, thresholdValue: e.target.value }))}
                aria-label="APY threshold"
                className="flex-1 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
              />
              <span className="text-gray-400 text-sm">%</span>
            </div>

            <input
              type="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              aria-label="Notification email"
              className="col-span-2 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none placeholder:text-gray-500"
            />
          </div>

          {formError && (
            <p role="alert" className="text-red-400 text-xs flex items-center gap-1">
              <AlertTriangle size={12} /> {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || activeAlerts.length >= MAX_ALERTS}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add Alert
          </button>

          <p className="text-xs text-gray-500 text-right">
            {activeAlerts.length}/{MAX_ALERTS} active alerts
          </p>
        </form>

        {/* Alert list */}
        <div className="overflow-y-auto flex-1 space-y-2 pr-1">
          {loading && (
            <div className="flex justify-center py-6">
              <Loader2 size={20} className="animate-spin text-gray-400" />
            </div>
          )}
          {!loading && alerts.length === 0 && (
            <p className="text-center text-gray-500 text-sm py-6">No alerts yet</p>
          )}
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`flex items-center justify-between gap-3 p-3 rounded-xl border ${
                alert.status === "triggered"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-white/10 bg-white/5"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium truncate">{alert.vaultId}</p>
                <p className="text-xs text-gray-400">
                  APY {alert.condition} {alert.thresholdValue}%
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {alert.status === "triggered" && (
                  <CheckCircle2 size={14} className="text-green-400" aria-label="Triggered" />
                )}
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    alert.status === "active"
                      ? "bg-indigo-500/20 text-indigo-300"
                      : "bg-green-500/20 text-green-300"
                  }`}
                >
                  {alert.status}
                </span>
                {alert.status === "active" && (
                  <button
                    type="button"
                    onClick={() => void handleDelete(alert.id)}
                    disabled={deletingId === alert.id}
                    aria-label={`Delete alert for ${alert.vaultId}`}
                    className="p-1 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    {deletingId === alert.id
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Trash2 size={13} />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
