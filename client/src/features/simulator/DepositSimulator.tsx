import React, { useState, useEffect } from "react";
import { fetchDepositSimulation } from "./simulationService";
import type { SimulationResult } from "../../../../../server/src/services/simulationService";

interface DepositSimulatorProps {
  strategyId: string;
  amount: number;
  token: string;
}

export const DepositSimulator: React.FC<DepositSimulatorProps> = ({
  strategyId,
  amount,
  token,
}) => {
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!amount || amount <= 0) {
        if (active) setSimulation(null);
        return;
      }
      if (active) {
        setLoading(true);
        setError(null);
      }
      try {
        const result = await fetchDepositSimulation({ strategyId, amount, token });
        if (active) setSimulation(result);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Error running simulation");
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [strategyId, amount, token]);

  if (loading) return <div className="p-4 text-gray-500 animate-pulse">Running simulation...</div>;
  if (error) return <div className="p-4 text-red-500 bg-red-50 rounded-md">Error: {error}</div>;
  if (!simulation) return <div className="p-4 text-gray-400 italic">Enter an amount to see the preview.</div>;

  return (
    <div className="p-6 border border-gray-200 rounded-lg shadow-sm bg-white mt-4 relative overflow-hidden">
      <div className="absolute top-2 right-2 bg-yellow-100 text-yellow-800 text-xs font-bold px-2 py-1 rounded">
        PREVIEW ONLY
      </div>
      
      <h3 className="text-xl font-bold mb-4 text-gray-800">Deposit Simulation</h3>
      
      {simulation.warnings.length > 0 && (
        <div className="mb-4 bg-orange-50 border-l-4 border-orange-400 p-4 rounded" role="alert">
          <p className="font-bold text-orange-800 mb-1">Warnings</p>
          <ul className="list-disc pl-5 text-orange-700 text-sm">
            {simulation.warnings.map((warning, idx) => (
              <li key={idx}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-50 p-3 rounded">
          <p className="text-sm text-gray-500 mb-1">Expected Shares</p>
          <p className="text-lg font-semibold">{simulation.expectedShares.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
        </div>
        <div className="bg-gray-50 p-3 rounded">
          <p className="text-sm text-gray-500 mb-1">Post-Deposit Expsosure (APY)</p>
          <p className="text-lg font-semibold">{(simulation.postDepositExposure.expectedApy * 100).toFixed(2)}%</p>
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
                  {alloc.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {token} ({alloc.percentage.toFixed(1)}%)
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
                <span className="font-medium text-gray-800">{fee.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      
    </div>
  );
};
