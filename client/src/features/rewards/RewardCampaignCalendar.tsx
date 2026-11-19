import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { apiFetch, apiUrl } from "../../lib/api";
import {
  campaignIncludesCalendarDay,
  findCampaignOverlaps,
  getCalendarDays,
  parseRewardCampaigns,
  type RewardCampaign,
} from "./campaignCalendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CAMPAIGN_COLORS = [
  "border-indigo-400/40 bg-indigo-500/15 text-indigo-100",
  "border-cyan-400/40 bg-cyan-500/15 text-cyan-100",
  "border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-100",
  "border-amber-400/40 bg-amber-500/15 text-amber-100",
];
const CALENDAR_UNAVAILABLE =
  "Reward campaign calendar is temporarily unavailable. Please try again.";

function monthLabel(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function dateLabel(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export default function RewardCampaignCalendar() {
  const [campaigns, setCampaigns] = useState<RewardCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [month, setMonth] = useState(
    () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
  );

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await apiFetch(apiUrl("/api/rewards/campaign-calendar"));
      if (!response.ok) throw new Error(CALENDAR_UNAVAILABLE);
      setCampaigns(parseRewardCampaigns(await response.json()));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  const days = useMemo(
    () => getCalendarDays(month.getUTCFullYear(), month.getUTCMonth()),
    [month],
  );
  const displayedCampaigns = useMemo(
    () =>
      campaigns.filter((campaign) => {
        const start = Date.parse(campaign.startDate);
        const end = Date.parse(campaign.endDate);
        const monthStart = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1);
        const nextMonth = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1);
        return start < nextMonth && end > monthStart;
      }),
    [campaigns, month],
  );
  const overlaps = useMemo(
      () => findCampaignOverlaps(displayedCampaigns),
      [displayedCampaigns],
  );
  const campaignColors = new Map<RewardCampaign, string>(
    displayedCampaigns.map(
      (campaign, index): [RewardCampaign, string] => [
        campaign,
        CAMPAIGN_COLORS[index % CAMPAIGN_COLORS.length],
      ],
    ),
  );

  const changeMonth = (offset: number) => {
    setMonth((current) =>
      new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + offset, 1)),
    );
  };

  return (
    <section
      aria-labelledby="reward-campaign-calendar-title"
      className="glass-panel mb-8 p-6"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <CalendarDays className="text-indigo-400" size={20} />
            <h2 id="reward-campaign-calendar-title" className="text-lg font-bold text-white">
              Reward campaign calendar
            </h2>
          </div>
          <p className="text-sm text-gray-400">
            Schedule windows and overlapping campaigns by protocol and token.
          </p>
        </div>
        <div className="flex items-center gap-2" aria-label="Calendar month controls">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => changeMonth(-1)}
            className="rounded-lg border border-white/10 p-2 text-gray-300 hover:bg-white/10"
          >
            <ChevronLeft size={18} />
          </button>
          <h3 aria-live="polite" className="min-w-32 text-center font-semibold text-white">
            {monthLabel(month)}
          </h3>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => changeMonth(1)}
            className="rounded-lg border border-white/10 p-2 text-gray-300 hover:bg-white/10"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {loading ? (
        <div aria-busy="true" className="flex items-center gap-2 py-8 text-sm text-gray-300">
          <Loader2 className="animate-spin" size={18} />
          Loading reward campaigns…
        </div>
      ) : error ? (
        <div role="alert" className="flex items-center justify-between gap-4 py-4 text-sm text-amber-200">
          <span>{CALENDAR_UNAVAILABLE}</span>
          <button
            type="button"
            onClick={() => void loadCampaigns()}
            className="rounded-lg border border-amber-200/30 px-3 py-1.5 hover:bg-amber-200/10"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {overlaps.length > 0 && (
            <div
              role="status"
              aria-label="Campaign overlap warnings"
              className="mb-4 space-y-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100"
            >
              {overlaps.map(({ first, second }) => (
                <p key={`${first.protocolName}:${first.tokenSymbol}:${first.startDate}:${second.startDate}`}>
                  Overlap: {first.protocolName} {first.tokenSymbol} campaigns{" "}
                  {dateLabel(new Date(first.startDate))}–{dateLabel(new Date(first.endDate))} and{" "}
                  {dateLabel(new Date(second.startDate))}–{dateLabel(new Date(second.endDate))}.
                </p>
              ))}
            </div>
          )}

          {displayedCampaigns.length === 0 && (
            <p className="mb-4 text-sm text-gray-400" role="status">
              {campaigns.length === 0
                ? "No reward campaigns are currently scheduled."
                : "No reward campaigns overlap this month."}
            </p>
          )}

          <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-white/10">
            {WEEKDAYS.map((weekday) => (
              <div
                key={weekday}
                className="border-b border-white/10 bg-white/5 px-2 py-2 text-center text-xs font-semibold text-gray-400"
              >
                {weekday}
              </div>
            ))}
            {days.map((day) => {
              const currentMonth = day.getUTCMonth() === month.getUTCMonth();
              const dayCampaigns = displayedCampaigns.filter((campaign) =>
                campaignIncludesCalendarDay(campaign, day),
              );
              return (
                <div
                  key={day.toISOString()}
                  aria-label={`${dateLabel(day)}${currentMonth ? "" : ", outside current month"}`}
                  className={`min-h-24 border-b border-r border-white/10 p-1.5 ${
                    currentMonth ? "bg-black/10" : "bg-black/25 opacity-50"
                  }`}
                >
                  <span className="text-xs text-gray-400">{day.getUTCDate()}</span>
                  <div className="mt-1 space-y-1">
                    {dayCampaigns.map((campaign) => (
                      <div
                        key={`${campaign.protocolName}:${campaign.tokenSymbol}:${campaign.startDate}`}
                        title={`${campaign.protocolName} ${campaign.tokenSymbol}${campaign.isActive ? "" : " (inactive)"}`}
                        className={`truncate rounded border px-1 py-0.5 text-[10px] leading-tight ${
                          campaignColors.get(campaign)
                        } ${campaign.isActive ? "" : "opacity-50 line-through"}`}
                      >
                        {campaign.protocolName} · {campaign.tokenSymbol}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {displayedCampaigns.length > 0 && (
            <ul aria-label="Campaign schedule legend" className="mt-4 flex flex-wrap gap-2">
              {displayedCampaigns.map((campaign) => (
                <li
                  key={`${campaign.protocolName}:${campaign.tokenSymbol}:${campaign.startDate}`}
                  className={`rounded border px-2 py-1 text-xs ${
                    campaignColors.get(campaign)
                  } ${campaign.isActive ? "" : "opacity-50 line-through"}`}
                >
                  {campaign.protocolName} · {campaign.tokenSymbol}:{" "}
                  {dateLabel(new Date(campaign.startDate))}–{dateLabel(new Date(campaign.endDate))}
                  {!campaign.isActive && " · inactive"}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
