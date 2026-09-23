import React, { useState, useEffect } from "react";
import { AlertTriangle, AlertCircle, Info } from "lucide-react";
import {
  fetchDepositSimulation,
  isSimulationCancellation,
} from "./simulationService";
import type { SimulationResult, SimulationWarning } from "./simulationService";

interface DepositSimulatorProps {
  strategyId: string;
  amount: number;
  token: string;
}

const SEVERITY_STYLES: Record<
  SimulationWarning["severity"],
  { container: string; icon: string; text: string; Icon: React.FC<{ size?: number; className?: string }> }
> = {
  info: {
    container: "bg-blue-500/10 border-l-4 border-blue-400",
    icon: "text-blue-400",
    text: "text-blue-300",
    Icon: Info,
  },
  warning: {
    container: "bg-orange-500/10 border-l-4 border-orange-400",
    icon: "text-orange-400",
    text: "text-orange-300",
    Icon: AlertTriangle,
  },
  critical: {
    container: "bg-red-500/10 border-l-4 border-red-500",
    icon: "text-red-400",
    text: "text-red-300",
    Icon: AlertCircle,
  },
};

function WarningItem({ warning }: { warning: SimulationWarning | string }) {
  const normWarning: SimulationWarning = typeof warning === "string"
    ? { code: "UNSUPPORTED_STRATEGY", severity: "warning", message: warning, remediation: "Adjust inputs or check network conditions" }
    : warning;
  const styles = SEVERITY_STYLES[normWarning.severity] || SEVERITY_STYLES.warning;
  const { Icon } = styles;
  return (
    <li className={`flex gap-3 p-3 rounded ${styles.container}`} role="alert">
      <Icon size={16} className={`${styles.icon} shrink-0 mt-0.5`} aria-hidden="true" />
      <div className="space-y-0.5 text-sm">
        <p className={`font-medium ${styles.text}`}>{normWarning.message}</p>
        {normWarning.remediation && (
          <p className="text-gray-400 text-xs">
            <span className="font-semibold text-gray-300">Suggestion: </span>
            {normWarning.remediation}
          </p>
        )}
        {normWarning.affectedField && (
          <p className="text-gray-500 text-xs font-mono">Field: {normWarning.affectedField}</p>
        )}
      </div>
    </li>
  );
}

export const DepositSimulator: React.FC<DepositSimulatorProps> = ({
  strategyId,
  amount,
  token,
}) => {
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Consistency checks: track latest requested amount to discard stale / out-of-order responses (#1180)
  const latestAmountRef = React.useRef(amount);
  const requestIdRef = React.useRef(0);

  useEffect(() => {
    latestAmountRef.current = amount;
    const controller = new AbortController();
    const currentRequestId = ++requestIdRef.current;
    const targetAmount = amount;

    if (!targetAmount || targetAmount <= 0) {
      setLoading(false);
      setError(null);
      setSimulation(null);
      return;
    }

    setLoading(true);
    setError(null);

    // Debounce rapid manual edits
    const debounceTimer = setTimeout(async () => {
      try {
        const result = await fetchDepositSimulation(
          { strategyId, amount: targetAmount, token },
          { signal: controller.signal }
        );

        // Discard stale responses if amount has changed or newer request started
        if (
          !controller.signal.aborted &&
          currentRequestId === requestIdRef.current &&
          targetAmount === latestAmountRef.current
        ) {
          setSimulation(result);
          setLoading(false);
        }
      } catch (err) {
        if (isSimulationCancellation(err) || controller.signal.aborted) {
          return;
        }
        if (
          currentRequestId === requestIdRef.current &&
          targetAmount === latestAmountRef.current
        ) {
          setError(err instanceof Error ? err.message : "Error running simulation");
          setLoading(false);
        }
      }
    }, 150);

    return () => {
      clearTimeout(debounceTimer);
      controller.abort();
    };
  }, [strategyId, amount, token]);

  if (loading) return <div className="p-4 text-gray-500 animate-pulse">Running simulation...</div>;
  if (error) return <div className="p-4 text-red-500 bg-red-50 rounded-md">Error: {error}</div>;
  if (!simulation) return <div className="p-4 text-gray-400 italic">Enter an amount to see the preview.</div>;

  const criticalWarnings = simulation.warnings.filter((w) => w.severity === "critical");
  const otherWarnings = simulation.warnings.filter((w) => w.severity !== "critical");

  return (
    <div className="p-6 border border-gray-200 rounded-lg shadow-sm bg-white mt-4 relative overflow-hidden">
      <div className="absolute top-2 right-2 bg-yellow-100 text-yellow-800 text-xs font-bold px-2 py-1 rounded">
        PREVIEW ONLY
      </div>

      <h3 className="text-xl font-bold mb-4 text-gray-800">Deposit Simulation</h3>

      {(criticalWarnings.length > 0 || otherWarnings.length > 0) && (
        <div className="mb-4">
          <h4 className="font-semibold text-gray-700 mb-2">Warnings</h4>
          {criticalWarnings.length > 0 && (
            <ul className="space-y-2 mb-2" aria-label="Critical warnings">
              {criticalWarnings.map((w, idx) => (
                <WarningItem key={idx} warning={w} />
              ))}
            </ul>
          )}
          {otherWarnings.length > 0 && (
            <ul className="space-y-2" aria-label="Simulation warnings">
              {otherWarnings.map((w, idx) => (
                <WarningItem key={idx} warning={w} />
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-50 p-3 rounded">
          <p className="text-sm text-gray-500 mb-1">Expected Shares</p>
          <p className="text-lg font-semibold">
            {simulation.expectedShares.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-gray-50 p-3 rounded">
          <p className="text-sm text-gray-500 mb-1">Post-Deposit Exposure (APY)</p>
          <p className="text-lg font-semibold">
            {(simulation.postDepositExposure.expectedApy * 100).toFixed(2)}%
          </p>
        </div>
      </div>

      <div className="mb-6">
        <h4 className="font-semibold text-gray-700 mb-2 border-b pb-1">Routing & Allocations</h4>
        {simulation.allocations.length === 0 ? (
          <p className="text-gray-500 text-sm italic">No routing expected.</p>
        ) : (
          <div className="space-y-2 mt-2">
            {simulation.allocations.map((alloc, idx) => (
              <div key={idx} className="flex justify-between items-center text-sm">
                <span className="font-medium text-gray-700">{alloc.protocol}</span>
                <span className="text-gray-600">
                  {alloc.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {token}{" "}
                  ({alloc.percentage.toFixed(1)}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h4 className="font-semibold text-gray-700 mb-2 border-b pb-1">Estimated Fees</h4>
        {simulation.fees.length === 0 ? (
          <p className="text-gray-500 text-sm italic">No fees expected.</p>
        ) : (
          <div className="space-y-1 mt-2">
            {simulation.fees.map((fee, idx) => (
              <div key={idx} className="flex justify-between items-center text-sm">
                <span className="text-gray-600">{fee.type}</span>
                <span className="font-medium text-gray-800">
                  {fee.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
