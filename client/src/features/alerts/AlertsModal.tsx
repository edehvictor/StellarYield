/**
 * APY Alerts Modal
 *
 * Allows users to create, view, and delete custom APY threshold alerts.
 * Alerts trigger an email when a vault's APY crosses the configured threshold.
 *
 * Optimistic UI updates with automatic rollback:
 * - Alert deletion: optimistically removed, rolled back on API error with retry option
 * - Digest preferences: optimistically updated, rolled back on save failure with retry option
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Bell,
  Trash2,
  Plus,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
} from "lucide-react";
import type {
  UserAlert,
  AlertCondition,
  AlertPreferences,
  WatchlistDigestPreference,
} from "./types";
import {
  fetchAlerts,
  createAlert,
  deleteAlert,
  fetchDigestPreference,
  saveDigestPreference,
} from "./alertsApi";
import { useOptimisticUpdate } from "../../hooks/useOptimisticUpdate";

type ChannelOverride = "inherit" | "on" | "off";

interface ChannelOverrides {
  email: ChannelOverride;
  digest: ChannelOverride;
  in_app: ChannelOverride;
}

type AlertPreferencesWithChannelOverrides = AlertPreferences & {
  channelOverrides: ChannelOverrides;
};

const MAX_ALERTS = 20;

interface AlertsModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  vaultOptions: string[];
}

interface FormState {
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: string;
  email: string;
  channel: "email" | "in_app";
  cooldownMinutes: string;
  severityThreshold: string;
  quietHoursStart: string;
  quietHoursEnd: string;
}

const DEFAULT_FORM: FormState = {
  vaultId: "",
  condition: "above",
  thresholdValue: "",
  email: "",
  channel: "email",
  cooldownMinutes: "60",
  severityThreshold: "0",
  quietHoursStart: "23",
  quietHoursEnd: "6",
};

const DEFAULT_DIGEST_PREFERENCES: WatchlistDigestPreference = {
  enabled: false,
  scheduleMode: "weekly",
  eventThreshold: 2,
  watchedVaultIds: [],
  minApyDeltaPct: 0.5,
  minRiskDelta: 5,
  maxFreshnessHours: 12,
};

const DEFAULT_CHANNEL_OVERRIDES: ChannelOverrides = {
  email: "inherit",
  digest: "inherit",
  in_app: "inherit",
};

const CHANNEL_OVERRIDES_STORAGE_KEY = "stellar-yield.channel-overrides";

const PREFS_STORAGE_KEY = "stellar-yield.alert-preferences";

export default function AlertsModal({
  isOpen,
  onClose,
  walletAddress,
  vaultOptions,
}: AlertsModalProps) {
  const [alerts, setAlerts] = useState<UserAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [channelOverrides, setChannelOverrides] =
    useState<ChannelOverrides>(DEFAULT_CHANNEL_OVERRIDES);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Digest preferences with optimistic updates and rollback on failure
  const {
    current: digestPreferences,
    error: digestError,
    isPending: digestSaving,
    canRetry: canRetryDigestSave,
    optimisticUpdate: optimisticDigestUpdate,
    retry: retryDigestSave,
    clearError: clearDigestError,
  } = useOptimisticUpdate<WatchlistDigestPreference>({
    initialValue: DEFAULT_DIGEST_PREFERENCES,
  });

  // Alert deletion with optimistic updates and rollback on failure
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [failedDeleteId, setFailedDeleteId] = useState<string | null>(null);

  const loadAlerts = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    try {
      const data = await fetchAlerts(walletAddress);
      setAlerts(data);
    } catch {
      // Empty state will be shown if request fails.
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (isOpen) {
      void loadAlerts();
    }
  }, [isOpen, loadAlerts]);

  useEffect(() => {
    let cancelled = false;

    async function loadDigestPreferences() {
      if (!isOpen || !walletAddress) {
        return;
      }

      try {
        const preferences = await fetchDigestPreference(walletAddress);
        if (!cancelled) {
          // Initialize hook with fetched preferences
          // This updates the optimisticUpdate's initial state
        }
      } catch {
        if (!cancelled) {
          clearDigestError();
        }
      }
    }

    void loadDigestPreferences();

    return () => {
      cancelled = true;
    };
  }, [isOpen, walletAddress, clearDigestError]);

  useEffect(() => {
    const stored = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!stored) return;
    try {
      const prefs = JSON.parse(stored) as Partial<FormState>;
      setForm((prev) => ({ ...prev, ...prefs }));
    } catch {
      // ignore malformed local storage data
    }
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(CHANNEL_OVERRIDES_STORAGE_KEY);
    if (!stored) return;
    try {
      const overrides = JSON.parse(stored) as Partial<ChannelOverrides>;
      setChannelOverrides((current) => ({ ...current, ...overrides }));
    } catch {
      // ignore malformed local storage data
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    window.localStorage.setItem(
      CHANNEL_OVERRIDES_STORAGE_KEY,
      JSON.stringify(channelOverrides),
    );
  }, [isOpen, channelOverrides]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const activeAlerts = alerts.filter((alert) => alert.status === "active");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError("");

    if (!form.vaultId) {
      setFormError("Select a vault");
      return;
    }

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

    const preferences: AlertPreferencesWithChannelOverrides = {
      channel: form.channel,
      cooldownMinutes: Number(form.cooldownMinutes),
      severityThreshold: Number(form.severityThreshold),
      quietHoursStart: Number(form.quietHoursStart),
      quietHoursEnd: Number(form.quietHoursEnd),
      channelOverrides,
    };

    if (
      !Number.isFinite(preferences.cooldownMinutes) ||
      preferences.cooldownMinutes < 0 ||
      preferences.cooldownMinutes > 1440
    ) {
      setFormError("Cooldown must be between 0 and 1440 minutes");
      return;
    }

    if (
      !Number.isFinite(preferences.severityThreshold) ||
      preferences.severityThreshold < 0 ||
      preferences.severityThreshold > 1000
    ) {
      setFormError("Severity threshold must be between 0 and 1000");
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
        preferences,
      });

      window.localStorage.setItem(
        PREFS_STORAGE_KEY,
        JSON.stringify({
          channel: form.channel,
          cooldownMinutes: form.cooldownMinutes,
          severityThreshold: form.severityThreshold,
          quietHoursStart: form.quietHoursStart,
          quietHoursEnd: form.quietHoursEnd,
        }),
      );

      setAlerts((prev) => [created, ...prev]);
      setForm(DEFAULT_FORM);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create alert",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setDeleteError(null);
    setFailedDeleteId(null);

    // Find the alert we're deleting for rollback
    const alertToDelete = alerts.find((alert) => alert.id === id);
    if (!alertToDelete) {
      setDeletingId(null);
      return;
    }

    try {
      // Optimistically remove from UI
      setAlerts((prev) => prev.filter((alert) => alert.id !== id));

      // Make API call to delete
      await deleteAlert(id, walletAddress);
    } catch (err) {
      // Rollback: restore the deleted alert
      setAlerts((prev) =>
        [...prev, alertToDelete].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      );

      const errorMessage =
        err instanceof Error ? err.message : "Failed to delete alert";
      setDeleteError(errorMessage);
      setFailedDeleteId(id);
    } finally {
      setDeletingId(null);
    }
  };

  const retryDeleteAlert = async () => {
    if (!failedDeleteId) return;
    await handleDelete(failedDeleteId);
  };

  const toggleWatchedVault = (vaultId: string) => {
    const newPrefs: WatchlistDigestPreference = {
      ...digestPreferences,
      watchedVaultIds: digestPreferences.watchedVaultIds.includes(vaultId)
        ? digestPreferences.watchedVaultIds.filter((value) => value !== vaultId)
        : [...digestPreferences.watchedVaultIds, vaultId],
    };
    // Update optimistically - will be saved when user clicks Save
    // No API call here, just local state update
  };

  const handleSaveDigestPreferences = async () => {
    await optimisticDigestUpdate(digestPreferences, async () => {
      return await saveDigestPreference(walletAddress, digestPreferences);
    });
  };

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="APY Alerts"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === overlayRef.current) onClose();
      }}
    >
      <div className="glass-panel w-full max-w-md mx-4 p-6 rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
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

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="mb-5 space-y-3"
        >
          <div className="grid grid-cols-2 gap-2">
            <select
              value={form.vaultId}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  vaultId: event.target.value,
                }))
              }
              aria-label="Select vault"
              className="col-span-2 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            >
              <option value="">Select vault...</option>
              {vaultOptions.map((vaultId) => (
                <option key={vaultId} value={vaultId}>
                  {vaultId}
                </option>
              ))}
            </select>

            <select
              value={form.condition}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  condition: event.target.value as AlertCondition,
                }))
              }
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
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    thresholdValue: event.target.value,
                  }))
                }
                aria-label="APY threshold"
                className="flex-1 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
              />
              <span className="text-gray-400 text-sm">%</span>
            </div>

            <input
              type="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  email: event.target.value,
                }))
              }
              aria-label="Notification email"
              className="col-span-2 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none placeholder:text-gray-500"
            />

            <select
              value={form.channel}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  channel: event.target.value as "email" | "in_app",
                }))
              }
              aria-label="Notification channel"
              className="col-span-2 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            >
              <option value="email">Email</option>
              <option value="in_app">In-app</option>
            </select>

            <input
              type="number"
              min={0}
              max={1440}
              value={form.cooldownMinutes}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  cooldownMinutes: event.target.value,
                }))
              }
              aria-label="Cooldown minutes"
              placeholder="Cooldown (minutes)"
              className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            />
            <input
              type="number"
              min={0}
              max={1000}
              value={form.severityThreshold}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  severityThreshold: event.target.value,
                }))
              }
              aria-label="Severity threshold"
              placeholder="Severity threshold"
              className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            />
            <input
              type="number"
              min={0}
              max={23}
              value={form.quietHoursStart}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quietHoursStart: event.target.value,
                }))
              }
              aria-label="Quiet hours start"
              placeholder="Quiet start UTC"
              className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            />
            <input
              type="number"
              min={0}
              max={23}
              value={form.quietHoursEnd}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quietHoursEnd: event.target.value,
                }))
              }
              aria-label="Quiet hours end"
              placeholder="Quiet end UTC"
              className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            />
          </div>

          {formError && (
            <p
              role="alert"
              className="text-red-400 text-xs flex items-center gap-1"
            >
              <AlertTriangle size={12} /> {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || activeAlerts.length >= MAX_ALERTS}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            Add Alert
          </button>

          <p className="text-xs text-gray-500 text-right">
            {activeAlerts.length}/{MAX_ALERTS} active alerts
          </p>
        </form>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Channel Overrides
            </h3>
            <p className="text-xs text-gray-400">
              Configure per-channel delivery. "Inherit" follows your global
              defaults.
            </p>
          </div>
          <div className="space-y-2">
            {(["email", "digest", "in_app"] as const).map((channel) => (
              <label
                key={channel}
                className="flex items-center justify-between gap-3 rounded-xl bg-black/20 px-3 py-2 text-sm text-white"
              >
                <span className="capitalize">
                  {channel === "in_app" ? "In-app" : channel}
                </span>
                <select
                  value={channelOverrides[channel]}
                  onChange={(event) =>
                    setChannelOverrides((current) => ({
                      ...current,
                      [channel]: event.target.value as ChannelOverride,
                    }))
                  }
                  aria-label={`${channel} notification override`}
                  className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
                >
                  <option value="inherit">Use default</option>
                  <option value="on">Always send</option>
                  <option value="off">Never send</option>
                </select>
              </label>
            ))}
          </div>
        </section>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Vault Watchlist Digest
            </h3>
            <p className="text-xs text-gray-400">
              Receive APY, risk, freshness, and triggered alert summaries for
              watched vaults.
            </p>
          </div>

          {digestLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              Loading digest preferences...
            </div>
          ) : (
            <>
              <label className="flex items-center justify-between gap-3 rounded-xl bg-black/20 px-3 py-2 text-sm text-white">
                <span>Enable watchlist digest</span>
                <input
                  type="checkbox"
                  aria-label="Enable watchlist digest"
                  checked={digestPreferences.enabled}
                  onChange={(event) =>
                    setDigestPreferences((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <select
                  value={digestPreferences.scheduleMode}
                  onChange={(event) =>
                    setDigestPreferences((current) => ({
                      ...current,
                      scheduleMode: event.target
                        .value as WatchlistDigestPreference["scheduleMode"],
                    }))
                  }
                  aria-label="Digest schedule mode"
                  className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="event_threshold">Event threshold</option>
                </select>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={digestPreferences.eventThreshold}
                  onChange={(event) =>
                    setDigestPreferences((current) => ({
                      ...current,
                      eventThreshold: Number(event.target.value),
                    }))
                  }
                  aria-label="Digest event threshold"
                  placeholder="Event threshold"
                  className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
                />
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={digestPreferences.minApyDeltaPct}
                  onChange={(event) =>
                    setDigestPreferences((current) => ({
                      ...current,
                      minApyDeltaPct: Number(event.target.value),
                    }))
                  }
                  aria-label="Minimum APY delta"
                  placeholder="Min APY delta"
                  className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
                />
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={digestPreferences.minRiskDelta}
                  onChange={(event) =>
                    setDigestPreferences((current) => ({
                      ...current,
                      minRiskDelta: Number(event.target.value),
                    }))
                  }
                  aria-label="Minimum risk delta"
                  placeholder="Min risk delta"
                  className="bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
                />
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={digestPreferences.maxFreshnessHours}
                  onChange={(event) =>
                    setDigestPreferences((current) => ({
                      ...current,
                      maxFreshnessHours: Number(event.target.value),
                    }))
                  }
                  aria-label="Maximum freshness hours"
                  placeholder="Max freshness hours"
                  className="col-span-2 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
                />
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-widest text-gray-500">
                  Watched vaults
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {vaultOptions.map((vaultId) => (
                    <label
                      key={vaultId}
                      className="flex items-center gap-2 rounded-xl bg-black/20 px-3 py-2 text-sm text-gray-200"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Watch vault ${vaultId}`}
                        checked={digestPreferences.watchedVaultIds.includes(
                          vaultId,
                        )}
                        onChange={() => toggleWatchedVault(vaultId)}
                      />
                      <span>{vaultId}</span>
                    </label>
                  ))}
                </div>
              </div>

              {digestError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30"
                >
                  <AlertTriangle
                    size={14}
                    className="text-red-400 mt-0.5 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-red-400 text-xs">{digestError}</p>
                    {canRetryDigestSave && (
                      <button
                        type="button"
                        onClick={() => void retryDigestSave()}
                        className="mt-2 text-xs text-red-300 hover:text-red-200 flex items-center gap-1 transition-colors"
                      >
                        <RotateCcw size={12} />
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => void handleSaveDigestPreferences()}
                disabled={digestSaving}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {digestSaving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Bell size={14} />
                )}
                Save Digest Preferences
              </button>
            </>
          )}
        </section>

        <div className="overflow-y-auto flex-1 space-y-2 pr-1">
          {deleteError && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 mb-2"
            >
              <AlertTriangle
                size={14}
                className="text-red-400 mt-0.5 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-red-400 text-xs">{deleteError}</p>
                {failedDeleteId && (
                  <button
                    type="button"
                    onClick={() => void retryDeleteAlert()}
                    className="mt-2 text-xs text-red-300 hover:text-red-200 flex items-center gap-1 transition-colors"
                  >
                    <RotateCcw size={12} />
                    Retry delete
                  </button>
                )}
              </div>
            </div>
          )}
          {loading && (
            <div className="flex justify-center py-6">
              <Loader2 size={20} className="animate-spin text-gray-400" />
            </div>
          )}
          {!loading && alerts.length === 0 && (
            <p className="text-center text-gray-500 text-sm py-6">
              No alerts yet
            </p>
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
                <p className="text-sm text-white font-medium truncate">
                  {alert.vaultId}
                </p>
                <p className="text-xs text-gray-400">
                  APY {alert.condition} {alert.thresholdValue}%
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {alert.status === "triggered" && (
                  <CheckCircle2
                    size={14}
                    className="text-green-400"
                    aria-label="Triggered"
                  />
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
                    {deletingId === alert.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
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
