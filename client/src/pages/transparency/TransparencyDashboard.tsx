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
import { useState, useEffect } from "react";
import { Loader2, TrendingUp, Flame, BarChart2 } from "lucide-react";
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

const API_BASE = getApiBaseUrl();

// ── Types ─────────────────────────────────────────────────────────────────

interface HistoryPoint {
    date: string;
    revenue: number;
    burned: number;
}

interface TransparencyData {
    totalRevenueLumens: number;
    totalBurnedTokens: number;
    deflationaryRatio: number;
    history: HistoryPoint[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatUSD(value: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
    }).format(value);
}

function formatTokens(value: number): string {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
        value,
    );
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

    useEffect(() => {
        async function fetchData() {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`${API_BASE}/api/transparency/summary`);
                if (!res.ok) {
                    throw new Error(`Server returned ${res.status}`);
                }
                const json: TransparencyData = await res.json();
                setData(json);
            } catch (err) {
                setError(
                    err instanceof Error
                        ? err.message
                        : "Unable to load transparency data.",
                );
            } finally {
                setLoading(false);
            }
        }
        void fetchData();
    }, []);

    // ── Truncate X-axis labels to MM/DD ───────────────────────────────────
    const chartData =
        data?.history.map((h) => ({
            ...h,
            label: h.date.slice(5), // "MM-DD"
        })) ?? [];

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-24">
                <Loader2 size={40} className="text-indigo-400 animate-spin mb-4" />
                <p className="text-gray-400">Loading protocol data…</p>
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex flex-col items-center justify-center py-24 text-center">
                <BarChart2 size={48} className="text-gray-500 mb-4" />
                <h2 className="text-2xl font-bold mb-2">Unable to load data</h2>
                <p className="text-gray-400">{error ?? "Unknown error"}</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            {/* Header */}
            <header>
                <h2 className="text-3xl font-extrabold tracking-tight">
                    Protocol Transparency
                </h2>
                <p className="text-gray-400 mt-1">
                    Real-time protocol revenue, $YIELD burns, and the deflationary ratio.
                </p>
            </header>

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
                    value={`${data.deflationaryRatio.toFixed(2)}%`}
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
        </div>
    );
}
