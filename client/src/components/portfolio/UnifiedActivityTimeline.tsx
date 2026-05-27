import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
  Wand2,
} from "lucide-react";
import { apiUrl } from "../../lib/api";
import type { AccountActivityEvent, AccountActivityEventType } from "./activityTimelineTypes";

const ACTIVITY_FILTERS: Array<{ type: AccountActivityEventType; label: string }> = [
  { type: "deposit", label: "Deposits" },
  { type: "withdrawal", label: "Withdrawals" },
  { type: "reward", label: "Rewards" },
  { type: "recommendation", label: "Recommendations" },
  { type: "alert", label: "Alerts" },
  { type: "rebalance", label: "Rebalances" },
];

function formatDateLabel(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimeLabel(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAmount(amountUsd?: number): string | null {
  if (typeof amountUsd !== "number") {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountUsd);
}

function getEventIcon(type: AccountActivityEventType) {
  switch (type) {
    case "deposit":
      return ArrowDownToLine;
    case "withdrawal":
      return ArrowUpFromLine;
    case "reward":
      return Sparkles;
    case "recommendation":
      return Wand2;
    case "alert":
      return Bell;
    case "rebalance":
      return GitBranch;
    default:
      return RefreshCw;
  }
}

function getSeverityStyles(severity?: AccountActivityEvent["severity"]): string {
  switch (severity) {
    case "critical":
      return "border-red-500/30 bg-red-500/10";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10";
    default:
      return "border-white/10 bg-white/5";
  }
}

interface UnifiedActivityTimelineProps {
  walletAddress: string;
}

export default function UnifiedActivityTimeline({
  walletAddress,
}: UnifiedActivityTimelineProps) {
  const [events, setEvents] = useState<AccountActivityEvent[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<AccountActivityEventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadTimeline() {
      setLoading(true);
      setError("");

      try {
        const query = selectedTypes.length
          ? `?types=${encodeURIComponent(selectedTypes.join(","))}`
          : "";
        const response = await fetch(
          apiUrl(`/api/portfolio/activity/${encodeURIComponent(walletAddress)}${query}`),
        );

        if (!response.ok) {
          throw new Error("Failed to load account activity timeline");
        }

        const payload = (await response.json()) as {
          timeline: AccountActivityEvent[];
        };

        if (!cancelled) {
          setEvents(payload.timeline ?? []);
        }
      } catch (loadError) {
        if (!cancelled) {
          setEvents([]);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load account activity timeline",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadTimeline();

    return () => {
      cancelled = true;
    };
  }, [selectedTypes, walletAddress]);

  const groupedEvents = useMemo(() => {
    const groups = new Map<string, AccountActivityEvent[]>();

    for (const event of events) {
      const label = formatDateLabel(event.timestamp);
      const existing = groups.get(label) ?? [];
      existing.push(event);
      groups.set(label, existing);
    }

    return Array.from(groups.entries());
  }, [events]);

  const toggleType = (type: AccountActivityEventType) => {
    setSelectedTypes((current) =>
      current.includes(type)
        ? current.filter((value) => value !== type)
        : [...current, type],
    );
  };

  return (
    <section className="glass-panel p-6 space-y-5" aria-label="Unified activity timeline">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-lg font-bold text-white">Unified Activity Timeline</h3>
          <p className="text-sm text-gray-400">
            Deposits, rewards, alerts, recommendations, and rebalances in one view.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {ACTIVITY_FILTERS.map((filter) => {
            const active = selectedTypes.includes(filter.type);
            return (
              <button
                key={filter.type}
                type="button"
                onClick={() => toggleType(filter.type)}
                aria-pressed={active}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? "bg-indigo-500 text-white"
                    : "bg-white/5 text-gray-300 hover:bg-white/10"
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          Loading activity timeline...
        </div>
      )}

      {!loading && error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 bg-black/20 p-8 text-center">
          <p className="text-sm font-medium text-white">No activity found for this view.</p>
          <p className="mt-2 text-sm text-gray-400">
            Try a different filter or wait for new portfolio events to land.
          </p>
        </div>
      )}

      {!loading && !error && events.length > 0 && (
        <div className="space-y-6">
          {groupedEvents.map(([dateLabel, dayEvents]) => (
            <div key={dateLabel} className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-white/10" />
                <h4 className="text-xs font-semibold uppercase tracking-[0.24em] text-gray-400">
                  {dateLabel}
                </h4>
                <div className="h-px flex-1 bg-white/10" />
              </div>

              <div className="space-y-3">
                {dayEvents.map((event) => {
                  const Icon = getEventIcon(event.type);
                  const amount = formatAmount(event.amountUsd);

                  return (
                    <article
                      key={event.id}
                      className={`rounded-2xl border p-4 ${getSeverityStyles(event.severity)}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 gap-3">
                          <div className="mt-0.5 rounded-full bg-black/20 p-2 text-white">
                            <Icon size={16} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-white">{event.title}</p>
                              <span className="rounded-full bg-black/20 px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-300">
                                {event.type}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-gray-300">{event.description}</p>
                            <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-400">
                              <span>{formatTimeLabel(event.timestamp)}</span>
                              <span>{event.source}</span>
                              {event.relatedVaultId && <span>{event.relatedVaultId}</span>}
                              {event.assetSymbol && <span>{event.assetSymbol}</span>}
                            </div>
                          </div>
                        </div>

                        {amount && (
                          <div className="shrink-0 text-right">
                            <p className="text-sm font-semibold text-white">{amount}</p>
                            <p className="text-xs text-gray-400">Estimated value</p>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
