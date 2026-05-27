import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, CheckCircle, RefreshCw } from "lucide-react";
import { apiUrl } from "../../lib/api";

type FeeAlertLevel = "normal" | "warning" | "critical";

interface FeeDeviationAlert {
  level: FeeAlertLevel;
  currentFee: number;
  baselineFee: number;
  deviationPct: number;
  warningThresholdPct: number;
  criticalThresholdPct: number;
  message: string;
  generatedAt: string;
}

interface FeeAlertResponse {
  estimate: {
    fees: { low: number; average: number; high: number };
    utilization: { congestionRatio: number };
    sampleSize: number;
    generatedAt: string;
  };
  alert: FeeDeviationAlert;
}

const LEVEL_STYLES: Record<
  FeeAlertLevel,
  { bg: string; border: string; text: string; icon: React.ReactNode }
> = {
  normal: {
    bg: "bg-green-500/10",
    border: "border-green-500/30",
    text: "text-green-400",
    icon: <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />,
  },
  warning: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    text: "text-amber-300",
    icon: <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />,
  },
  critical: {
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    text: "text-red-300",
    icon: <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />,
  },
};

export default function FeeDeviationAlertBanner() {
  const [data, setData] = useState<FeeAlertResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAlert = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(apiUrl("/api/fees/alert"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as FeeAlertResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load fee alert");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAlert();
    const interval = setInterval(() => void fetchAlert(), 60_000);
    return () => clearInterval(interval);
  }, [fetchAlert]);

  if (loading && !data) return null;
  if (error || !data) return null;

  const { alert, estimate } = data;
  const styles = LEVEL_STYLES[alert.level];

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg border ${styles.bg} ${styles.border}`}
    >
      {styles.icon}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Bell className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-xs font-medium text-gray-300">Fee Oracle</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchAlert()}
            disabled={loading}
            className="text-gray-500 hover:text-gray-300"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <p className={`text-sm mt-0.5 ${styles.text}`}>{alert.message}</p>
        <div className="flex gap-4 mt-1 text-xs text-gray-500">
          <span>
            Current:{" "}
            <span className="text-gray-300">{alert.currentFee.toLocaleString()} stroops</span>
          </span>
          <span>
            Baseline:{" "}
            <span className="text-gray-300">{alert.baselineFee.toLocaleString()} stroops</span>
          </span>
          <span>
            Network fee (avg):{" "}
            <span className="text-gray-300">{estimate.fees.average.toLocaleString()} stroops</span>
          </span>
          {estimate.utilization.congestionRatio > 0 && (
            <span>
              Congestion:{" "}
              <span className="text-gray-300">
                {(estimate.utilization.congestionRatio * 100).toFixed(0)}%
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
