/**
 * TransparencyDashboard.tsx
 *
 * /transparency — Protocol Revenue & Token Burn Dashboard
 *
 * Features:
 *  - Total Revenue counter
 *  - Total Burned counter
 *  - Deflationary Ratio metric
 *  - 30-day historical line chart (Recharts)
 *
 * Data is cached server-side; the page shows a loading skeleton while
 * the first fetch is in flight.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, TrendingUp, Flame, BarChart2, AlertTriangle, CheckCircle, Clock, RefreshCw } from "lucide-react";
import { getTransparencyStageLabel } from "../../../../shared/types/transparencyDiagnostic";
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
} from "recharts";
import { getApiBaseUrl } from "../../lib/api";
import {
    buildTransparencySummaryUrl,
    formatTransparencyContext,
    getExpectedTransparencyNetwork,
    readTransparencySummaryResponse,
    TRANSPARENCY_SCHEMA_VERSION,
    type TransparencyContext,
} from "./transparencyContextClient";
import { parseSmokeHistory, parseSmokeRunResult } from "./smokeResults";
import VaultReliabilityPanel from "./VaultReliabilityPanel";
import VaultSharePriceReconcilePanel from "../../features/vault_share_price/VaultSharePriceReconcilePanel";
import AuditReplayReportPanel from "./AuditReplayReportPanel";
import SorobanRpcFailoverPanel from "../../components/SorobanRpcFailoverPanel";
import RegistryDiffPage from "./RegistryDiff";
import DeploymentManifestVerifier from "../../components/DeploymentManifestVerifier";
import registryJson from "../../../../contracts/registry.json";
import prevRegistryJson from "../../../../contracts/registry.previous.json";
import {
    assessRegistryFromRecords,
    getStateLabel,
    getSubsystemLabel,
    mapSmokeTestStatus,
    parseIndexerStatusPayload,
    parseRelayerStatusPayload,
    summarizeTransparencyHealth,
    validateFailoverIncidentsPayload,
    validateTransparencySummaryPayload,
    type SubsystemState,
    type TransparencyHealthInput,
    type TransparencyHealthSummary,
    type TransparencySummaryPayload,
    type ValidatedFailoverIncident,
} from "./transparencyServiceHealth";

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

// ── Types ─────────────────────────────────────────────────────────────────

type TransparencyData = TransparencySummaryPayload;

type FailoverIncident = ValidatedFailoverIncident;

// ── Helpers ───────────────────────────────────────────────────────────────

function formatUSD(value: number): string {
    if (!Number.isFinite(value)) return "$0";
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
    }).format(Math.max(0, value));
}

function formatTokens(value: number): string {
    if (!Number.isFinite(value)) return "0";
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
        Math.max(0, value),
    );
}

function formatRatio(value: number): string {
    if (!Number.isFinite(value)) return "0.00%";
    return `${Math.min(100, Math.max(0, value)).toFixed(2)}%`;
}

// ── Sub-components ────────────────────────────────────────────────────────

interface StatCardProps {
    icon: React.ReactNode;
    title: string;
    value: string;
    subtitle?: string;
    accent?: string;
}

function StatCard({ icon, title, value, subtitle, accent = "indigo" }: StatCardProps) {
    return (
        <div
            className={`glass-panel rounded-2xl p-6 flex items-center gap-4 border border-${accent}-500/10`}
        >
            <span
                className={`w-12 h-12 rounded-full bg-${accent}-500/20 flex items-center justify-center flex-shrink-0`}
            >
                {icon}
            </span>
            <div>
                <p className="text-xs text-gray-400">{title}</p>
                <p className="text-2xl font-extrabold text-white">{value}</p>
                {subtitle && (
                    <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
                )}
            </div>
        </div>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function TransparencyDashboard() {
    const [data, setData] = useState<TransparencyData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [smokeStatus, setSmokeStatus] = useState<ReturnType<typeof parseSmokeRunResult>>(null);
    const [smokeHistory, setSmokeHistory] = useState<Array<NonNullable<ReturnType<typeof parseSmokeRunResult>>>>([]);
    const [failoverIncidents, setFailoverIncidents] = useState<FailoverIncident[]>([]);
    const [healthSummary, setHealthSummary] = useState<TransparencyHealthSummary | null>(null);
    /** Retry counter: bumping it re-runs the reads without clearing existing state. */
    const [reloadToken, setReloadToken] = useState(0);
    /** Last observed subsystem signals, used to preserve state when a retry fails. */
    const lastHealthRef = useRef<Partial<TransparencyHealthInput> | null>(null);

    const handleRetry = () => setReloadToken((token) => token + 1);

    // Network, ledger and version of the snapshot on screen (#1916). A ref so
    // a slow response from an earlier request is judged against the latest
    // accepted snapshot, not the one current when it was sent.
    const contextRef = useRef<TransparencyContext | null>(null);
    const [snapshotContext, setSnapshotContext] = useState<TransparencyContext | null>(null);
    const [contextNotice, setContextNotice] = useState<string | null>(null);
    const expectedNetwork = getExpectedTransparencyNetwork();

    const fetchData = useCallback(async () => {
        setLoading((prev) => (data === null ? true : prev));
        setError(null);
        try {
            // A source still catching up to the ledger already shown is
            // retried briefly; every other mismatch is final.
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const request = { network: expectedNetwork, current: contextRef.current };
                const res = await fetch(buildTransparencySummaryUrl(getApiBase(), request));
                const result = await readTransparencySummaryResponse(res, request);
                if (result.kind === "accept") {
                    if (result.context) {
                        contextRef.current = result.context;
                        setSnapshotContext(result.context);
                    }
                    setContextNotice(null);
                    setData(result.data);
                    return;
                }
                if (result.error.retryable && attempt < 2) {
                    await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
                    continue;
                }
                // Keep the snapshot on screen; explain why the update was refused.
                setContextNotice(result.error.message);
                if (contextRef.current === null) setError(result.error.message);
                return;
            }
        } catch (err) {
            // Preserve existing state and balances if a previous valid snapshot
            // is already loaded; only surface error state when no snapshot exists
            // or as a non-destructive refresh warning.
            setError(
                err instanceof Error
                    ? err.message
                    : "Unable to load transparency data.",
            );
        } finally {
            setLoading(false);
        }
    }, [data, expectedNetwork]);

    useEffect(() => {
        void fetchData();
        // Re-run on Retry; fetchData reads the latest snapshot via its own closure.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadToken]);

    useEffect(() => {
        const raw = window.localStorage.getItem("stellar-yield.smoke-results");
        setSmokeStatus(raw ? parseSmokeRunResult(raw) : null);
        const rawHistory = window.localStorage.getItem("stellar-yield.smoke-history");
        setSmokeHistory(parseSmokeHistory(rawHistory));
    }, [reloadToken]);

    useEffect(() => {
        let cancelled = false;
        async function loadFailoverHistory() {
            // Retry transient failures without replacing a previously loaded
            // snapshot with an empty result. The API is read-only and safe to retry.
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    const params = new URLSearchParams({ version: TRANSPARENCY_SCHEMA_VERSION });
                    if (expectedNetwork) params.set("network", expectedNetwork);
                    const response = await fetch(
                        `${getApiBase()}/api/transparency/failover-history?${params.toString()}`,
                    );
                    // Another network's incidents are never shown (#1916).
                    if (response.status === 409) return;
                    if (!response.ok) throw new Error(`Server returned ${response.status}`);
                    const payload: unknown = await response.json();
                    const validatedIncidents = validateFailoverIncidentsPayload(payload);
                    if (!cancelled) setFailoverIncidents(validatedIncidents);
                    return;
                } catch {
                    if (attempt < 2) {
                        await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
                    }
                }
            }
        }
        void loadFailoverHistory();
        return () => { cancelled = true; };
    }, [expectedNetwork, reloadToken]);

    useEffect(() => {
        async function loadServiceHealth() {
            const registryState = assessRegistryFromRecords(
                registryJson as unknown as Record<string, Record<string, string>>,
                prevRegistryJson as unknown as Record<string, Record<string, string>>,
            );

            let indexerState: SubsystemState = "unknown";
            let relayerState: SubsystemState = "unknown";

            // Settle each read independently so one transient failure does not
            // discard the other subsystem's usable signal.
            const [indexerResult, relayerResult] = await Promise.allSettled([
                fetch(`${getApiBase()}/api/indexer/status`),
                fetch(`${getApiBase()}/api/relayer/status`),
            ]);

            if (indexerResult.status === "fulfilled" && indexerResult.value.ok) {
                try {
                    const indexerJson: unknown = await indexerResult.value.json();
                    indexerState = parseIndexerStatusPayload(indexerJson);
                } catch {
                    indexerState = "unknown";
                }
            }

            if (relayerResult.status === "fulfilled" && relayerResult.value.ok) {
                try {
                    const relayerJson: unknown = await relayerResult.value.json();
                    relayerState = parseRelayerStatusPayload(relayerJson);
                } catch {
                    relayerState = "unknown";
                }
            }

            const smokeState = mapSmokeTestStatus(
                smokeStatus?.status ?? null,
                smokeStatus?.checks,
            );

            // Preserve last known-good signals when a retry comes back missing.
            const summary = summarizeTransparencyHealth(
                {
                    indexer: indexerState,
                    relayer: relayerState,
                    registry: registryState,
                    smokeTest: smokeState,
                },
                lastHealthRef.current ?? undefined,
            );
            lastHealthRef.current = summary.subsystems;
            setHealthSummary(summary);
        }

        void loadServiceHealth();
    }, [smokeStatus, reloadToken]);

    const healthBadgeClass = (state: SubsystemState) => {
        switch (state) {
            case "healthy":
                return "text-green-300 bg-green-500/10 border-green-500/30";
            case "degraded":
                return "text-yellow-300 bg-yellow-500/10 border-yellow-500/30";
            case "failed":
                return "text-red-300 bg-red-500/10 border-red-500/30";
            default:
                return "text-gray-300 bg-gray-500/10 border-gray-500/30";
        }
    };

    // ── Truncate X-axis labels to MM/DD ───────────────────────────────────
    const chartData =
        data?.history.map((h) => ({
            ...h,
            label: h.date.slice(5), // "MM-DD"
        })) ?? [];

    if (loading && !data) {
        return (
            <div className="flex flex-col items-center justify-center py-24">
                <Loader2 size={40} className="text-indigo-400 animate-spin mb-4" />
                <p className="text-gray-400">Loading protocol data…</p>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="flex flex-col items-center justify-center py-24 text-center">
                <BarChart2 size={48} className="text-gray-500 mb-4" />
                <h2 className="text-2xl font-bold mb-2">Unable to load data</h2>
                <p className="text-gray-400 mb-4">{error ?? "Unknown error"}</p>
                <button
                    type="button"
                    onClick={() => void fetchData()}
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                >
                    Try Again
                </button>
            </div>
        );
    }

    const summaryDiagnostics = data.diagnostics ?? [];

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            {/* Header */}
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="text-3xl font-extrabold tracking-tight">
                        Protocol Transparency
                    </h2>
                    <p className="text-gray-400 mt-1">
                        Real-time protocol revenue, $YIELD burns, and the deflationary ratio.
                    </p>
                    {snapshotContext && (
                        <p
                            data-testid="transparency-context"
                            className="text-xs text-gray-500 mt-1 font-mono"
                        >
                            {formatTransparencyContext(snapshotContext)}
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => void fetchData()}
                    aria-label="Refresh transparency data"
                    className="px-3 py-1.5 rounded-xl border border-gray-700 hover:border-indigo-400 text-xs text-gray-300 transition-colors"
                >
                    Refresh
                </button>
            </header>

            {/* A refused or failed refresh keeps the rendered snapshot visible. */}
            {(contextNotice || error) && (
                <div
                    role="status"
                    data-testid="transparency-refresh-notice"
                    className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm flex items-start justify-between gap-4"
                >
                    <span className="flex items-start gap-2">
                        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                        <span>
                            {contextNotice
                                ? `${contextNotice} The figures below are the last snapshot that matched this network.`
                                : `Showing the last known-good snapshot. Latest refresh failed: ${error}`}
                        </span>
                    </span>
                    <button
                        type="button"
                        onClick={handleRetry}
                        className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
                    >
                        <RefreshCw size={12} /> Retry
                    </button>
                </div>
            )}

            {summaryDiagnostics.length > 0 && (
                <div
                    role="alert"
                    aria-label="Transparency data diagnostics"
                    className="glass-panel rounded-2xl p-6 border border-amber-500/20"
                >
                    <div className="flex items-center justify-between gap-4 mb-3">
                        <div className="flex items-center gap-2">
                            <AlertTriangle size={18} className="text-amber-400" />
                            <h3 className="font-semibold text-white">Transparency data diagnostics</h3>
                        </div>
                        <span className="text-xs uppercase tracking-wide text-amber-300">
                            {data.status ?? "degraded"}
                        </span>
                    </div>
                    <ul className="space-y-2">
                        {summaryDiagnostics.map((diagnostic, index) => (
                            <li
                                key={`${diagnostic.code}-${diagnostic.stage}-${index}`}
                                className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3"
                            >
                                <p className="text-xs uppercase tracking-wide text-amber-300">
                                    {getTransparencyStageLabel(diagnostic.stage)} · {diagnostic.code}
                                </p>
                                <p className="text-sm text-white mt-1">{diagnostic.summary}</p>
                                <p className="text-xs text-gray-400 mt-1">
                                    Next: {diagnostic.remediation}
                                </p>
                            </li>
                        ))}
                    </ul>
                    <button
                        type="button"
                        onClick={handleRetry}
                        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
                    >
                        <RefreshCw size={12} /> Retry
                    </button>
                </div>
            )}

            {/* Stat cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                    icon={<TrendingUp size={22} className="text-indigo-400" />}
                    title="Total Revenue (30d)"
                    value={formatUSD(data.totalRevenueLumens)}
                    subtitle="Across all vaults"
                    accent="indigo"
                />
                <StatCard
                    icon={<Flame size={22} className="text-orange-400" />}
                    title="Total $YIELD Burned (30d)"
                    value={formatTokens(data.totalBurnedTokens)}
                    subtitle="Sent to burn address"
                    accent="orange"
                />
                <StatCard
                    icon={<BarChart2 size={22} className="text-purple-400" />}
                    title="Deflationary Ratio"
                    value={formatRatio(data.deflationaryRatio)}
                    subtitle="Burn rate vs. emission rate"
                    accent="purple"
                />
            </div>

            {/* Historical chart */}
            <div className="glass-panel rounded-2xl p-6">
                <h3 className="font-semibold text-white mb-4">30-Day History</h3>
                <ResponsiveContainer width="100%" height={320}>
                    <LineChart
                        data={chartData}
                        margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                    >
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis
                            dataKey="label"
                            tick={{ fill: "#9ca3af", fontSize: 11 }}
                            interval={4}
                        />
                        <YAxis
                            yAxisId="revenue"
                            tick={{ fill: "#9ca3af", fontSize: 11 }}
                            tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                        />
                        <YAxis
                            yAxisId="burned"
                            orientation="right"
                            tick={{ fill: "#9ca3af", fontSize: 11 }}
                            tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`}
                        />
                        <Tooltip
                            contentStyle={{
                                background: "#111827",
                                border: "1px solid #374151",
                                borderRadius: "0.75rem",
                            }}
                            labelStyle={{ color: "#e5e7eb" }}
                            formatter={(value: number, name: string) =>
                                name === "revenue"
                                    ? [formatUSD(value), "Revenue"]
                                    : [formatTokens(value), "Burned"]
                            }
                        />
                        <Legend
                            formatter={(value) =>
                                value === "revenue" ? "Revenue (USD)" : "Burned (YIELD)"
                            }
                            wrapperStyle={{ color: "#9ca3af", fontSize: 12 }}
                        />
                        <Line
                            yAxisId="revenue"
                            type="monotone"
                            dataKey="revenue"
                            stroke="#6366f1"
                            strokeWidth={2}
                            dot={false}
                        />
                        <Line
                            yAxisId="burned"
                            type="monotone"
                            dataKey="burned"
                            stroke="#f97316"
                            strokeWidth={2}
                            dot={false}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>

            <SorobanRpcFailoverPanel />
            {healthSummary && (
                <div
                    className="glass-panel rounded-2xl p-6"
                    role="region"
                    aria-label="Service health summary"
                >
                    <div className="flex items-center gap-2 mb-4">
                        <AlertTriangle size={18} className="text-amber-400" />
                        <h3 className="font-semibold text-white">Service Health Summary</h3>
                    </div>
                    <p
                        className={`text-sm mb-4 ${
                            healthSummary.overall === "healthy"
                                ? "text-green-300"
                                : healthSummary.overall === "failed"
                                  ? "text-red-300"
                                  : "text-yellow-300"
                        }`}
                    >
                        {healthSummary.summaryMessage}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        {(Object.keys(healthSummary.subsystems) as Array<
                            keyof typeof healthSummary.subsystems
                        >).map((key) => {
                            const state = healthSummary.subsystems[key];
                            return (
                                <div
                                    key={key}
                                    className={`rounded-xl border px-3 py-2 ${healthBadgeClass(state)}`}
                                >
                                    <p className="text-xs uppercase tracking-wide opacity-80">
                                        {getSubsystemLabel(key)}
                                    </p>
                                    <p className="text-sm font-semibold">{getStateLabel(state)}</p>
                                </div>
                            );
                        })}
                    </div>
                    {healthSummary.diagnostics.length > 0 && (
                        <div className="mt-4 space-y-2">
                            {healthSummary.diagnostics.map((diagnostic, index) => (
                                <div
                                    key={`${diagnostic.code}-${diagnostic.stage}-${index}`}
                                    className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3"
                                >
                                    <p className="text-xs uppercase tracking-wide text-amber-300">
                                        {getTransparencyStageLabel(diagnostic.stage)} · {diagnostic.code}
                                    </p>
                                    <p className="text-xs text-gray-400 mt-1">
                                        Next: {diagnostic.remediation}
                                    </p>
                                </div>
                            ))}
                            {!healthSummary.contextSufficient && (
                                <button
                                    type="button"
                                    onClick={handleRetry}
                                    className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
                                >
                                    <RefreshCw size={12} /> Retry
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            <div className="glass-panel rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-4">
                    <AlertTriangle size={18} className="text-amber-400" />
                    <h3 className="font-semibold text-white">Provider Failover Incident History</h3>
                </div>
                {failoverIncidents.length === 0 ? (
                    <p className="text-sm text-gray-400">No failover incidents recorded.</p>
                ) : (
                    <ul className="space-y-3">
                        {failoverIncidents.slice(0, 10).map((inc) => (
                            <li
                                key={inc.id}
                                className={`rounded-xl border p-3 ${
                                    inc.resolved
                                        ? "border-green-500/20 bg-green-500/5"
                                        : "border-amber-500/20 bg-amber-500/5"
                                }`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-sm font-semibold text-white">
                                        {inc.protocolName}
                                    </span>
                                    <span
                                        className={`flex items-center gap-1 text-xs font-medium ${
                                            inc.resolved ? "text-green-400" : "text-amber-400"
                                        }`}
                                    >
                                        {inc.resolved ? (
                                            <><CheckCircle size={12} /> Recovered</>
                                        ) : (
                                            <><Clock size={12} /> Active</>
                                        )}
                                    </span>
                                </div>
                                <p className="text-xs text-gray-400 capitalize">
                                    Trigger: {inc.trigger.replace("_", " ")}
                                </p>
                                <p className="text-xs text-gray-500 mt-0.5">
                                    Started: {new Date(inc.startedAt).toLocaleString()}
                                </p>
                                {inc.recoveredAt && (
                                    <p className="text-xs text-green-400 mt-0.5">
                                        Recovered: {new Date(inc.recoveredAt).toLocaleString()}
                                        {inc.durationMs !== undefined && (
                                            <> ({Math.round(inc.durationMs / 1000)}s outage)</>
                                        )}
                                    </p>
                                )}
                                {inc.reasons.length > 0 && (
                                    <p className="text-xs text-gray-500 mt-1 truncate">
                                        {inc.reasons[0]}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="glass-panel rounded-2xl p-6">
                <h3 className="font-semibold text-white mb-2">Smoke Test Status</h3>
                {smokeStatus ? (
                    <>
                        <p className={`text-sm ${smokeStatus.status === "pass" ? "text-green-300" : "text-red-300"}`}>
                            Latest run: {smokeStatus.status.toUpperCase()} ({new Date(smokeStatus.timestamp).toLocaleString()})
                        </p>
                        <ul className="mt-3 space-y-1 text-xs text-gray-300">
                            {smokeStatus.checks.slice(0, 6).map((check) => (
                                <li key={`${check.label}-${check.url}`}>
                                    {check.status === "pass" ? "PASS" : "FAIL"} - {check.label} ({check.httpCode})
                                </li>
                            ))}
                        </ul>
                        {smokeHistory.length > 0 && (
                            <div className="mt-4">
                                <p className="text-xs text-gray-400 mb-1">Recent pass/fail history</p>
                                <ul className="text-xs text-gray-300 space-y-1">
                                    {smokeHistory.slice(0, 5).map((entry, idx) => (
                                        <li key={`${entry?.timestamp ?? idx}`}>
                                            {entry?.status.toUpperCase()} - {entry ? new Date(entry.timestamp).toLocaleString() : "Invalid record"}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </>
                ) : (
                    <p className="text-sm text-gray-400">
                        No stored smoke history found. Save a JSON run to localStorage key <code>stellar-yield.smoke-results</code>.
                    </p>
                )}
            </div>

            {/* Data Source Reliability */}
            <VaultReliabilityPanel />
            <VaultSharePriceReconcilePanel />
            <AuditReplayReportPanel />
            <DeploymentManifestVerifier />
            <RegistryDiffPage />
        </div>
    );
}
