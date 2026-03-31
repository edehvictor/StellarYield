import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

export default function AnalyticsDashboard() {
  const [sql, setSql] = useState(
    "SELECT protocol, apy, tvl FROM \"YieldSnapshot\" ORDER BY \"createdAt\" DESC LIMIT 20",
  );
  const [xKey, setXKey] = useState("");
  const [yKey, setYKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);

  const keys = useMemo(() => {
    if (!result || result.rows.length === 0) return [];
    return Object.keys(result.rows[0]);
  }, [result]);

  const numericKeys = useMemo(() => {
    if (!result || result.rows.length === 0) return [];
    return keys.filter((key) =>
      result.rows.some((row) => typeof row[key] === "number"),
    );
  }, [keys, result]);

  async function runQuery() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/analytics/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const payload = (await response.json()) as QueryResult & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Query failed.");
      }
      setResult(payload);

      const firstKey = payload.rows[0] ? Object.keys(payload.rows[0])[0] : "";
      const firstNumeric = payload.rows[0]
        ? Object.keys(payload.rows[0]).find((k) => typeof payload.rows[0][k] === "number") ?? ""
        : "";
      setXKey((prev) => prev || firstKey);
      setYKey((prev) => prev || firstNumeric);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run query.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="glass-card p-6 space-y-4">
        <h2 className="text-2xl font-bold">Custom SQL Analytics</h2>
        <p className="text-sm text-gray-300">
          Run read-only SQL against the analytics replica and turn results into charts.
        </p>
        <div className="border border-gray-700 rounded-xl overflow-hidden">
          <Editor
            height="240px"
            defaultLanguage="sql"
            value={sql}
            onChange={(value) => setSql(value ?? "")}
            theme="vs-dark"
            options={{ minimap: { enabled: false }, fontSize: 14 }}
          />
        </div>
        <button
          onClick={runQuery}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-semibold disabled:opacity-50"
        >
          {loading ? "Running..." : "Run Query"}
        </button>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </section>

      <section className="glass-card p-6 space-y-4">
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">X-axis</label>
            <select
              className="bg-[#1a1a2e] border border-gray-700 rounded px-3 py-2"
              value={xKey}
              onChange={(e) => setXKey(e.target.value)}
            >
              <option value="">Select</option>
              {keys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Y-axis</label>
            <select
              className="bg-[#1a1a2e] border border-gray-700 rounded px-3 py-2"
              value={yKey}
              onChange={(e) => setYKey(e.target.value)}
            >
              <option value="">Select</option>
              {numericKeys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="h-80">
          {result && result.rows.length > 0 && xKey && yKey ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={result.rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2f3349" />
                <XAxis dataKey={xKey} stroke="#b8bfd9" />
                <YAxis stroke="#b8bfd9" />
                <Tooltip />
                <Line type="monotone" dataKey={yKey} stroke="#7c90ff" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-gray-400">
              Run a query and select chart keys to visualize results.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
