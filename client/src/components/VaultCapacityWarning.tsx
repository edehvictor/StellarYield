import { AlertCircle, TrendingUp, Zap } from "lucide-react";

export interface VaultCapacityStatus {
  vaultId: string;
  currentUtilization: number;
  isNearCapacity: boolean;
  isAtCapacity: boolean;
  availableCapacity: bigint;
  recommendedMaxDeposit: bigint;
  status: "normal" | "near_capacity" | "over_capacity";
  warnings: string[];
}

interface VaultCapacityWarningProps {
  capacity: VaultCapacityStatus;
  depositAmount?: bigint;
}

/**
 * VaultCapacityWarning — Displays vault capacity status and warnings
 */
export default function VaultCapacityWarning({
  capacity,
  depositAmount,
}: VaultCapacityWarningProps) {
  if (capacity.status === "normal" && !depositAmount) {
    return null;
  }

  const utilizationColor =
    capacity.status === "over_capacity"
      ? "text-red-400"
      : capacity.status === "near_capacity"
        ? "text-yellow-400"
        : "text-green-400";

  const bgColor =
    capacity.status === "over_capacity"
      ? "bg-red-500/10 border-red-500/20"
      : capacity.status === "near_capacity"
        ? "bg-yellow-500/10 border-yellow-500/20"
        : "bg-green-500/10 border-green-500/20";

  const iconColor =
    capacity.status === "over_capacity"
      ? "text-red-400"
      : capacity.status === "near_capacity"
        ? "text-yellow-400"
        : "text-green-400";

  return (
    <div className={`border rounded-lg p-4 space-y-3 ${bgColor}`}>
      <div className="flex items-start gap-3">
        {capacity.status === "over_capacity" ? (
          <AlertCircle className={`${iconColor} shrink-0 mt-0.5`} size={20} />
        ) : (
          <TrendingUp className={`${iconColor} shrink-0 mt-0.5`} size={20} />
        )}

        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-white">Vault Capacity</h3>
            <span className={`text-sm font-medium ${utilizationColor}`}>
              {capacity.currentUtilization.toFixed(1)}%
            </span>
          </div>

          {/* Capacity Bar */}
          <div className="w-full bg-black/30 rounded-full h-2 mb-2 overflow-hidden">
            <div
              className={`h-full transition-all ${
                capacity.status === "over_capacity"
                  ? "bg-red-500"
                  : capacity.status === "near_capacity"
                    ? "bg-yellow-500"
                    : "bg-green-500"
              }`}
              style={{
                width: `${Math.min(capacity.currentUtilization, 100)}%`,
              }}
            />
          </div>

          {/* Status Message */}
          <p className="text-sm text-gray-300 mb-2">
            {capacity.status === "over_capacity"
              ? "Vault is at or exceeding capacity. New deposits may experience degraded execution."
              : capacity.status === "near_capacity"
                ? "Vault is approaching capacity. Consider smaller deposits or alternative vaults."
                : "Vault has healthy capacity for deposits."}
          </p>

          {/* Warnings */}
          {capacity.warnings.length > 0 && (
            <ul className="text-xs text-gray-400 space-y-1 mb-2">
              {capacity.warnings.map((warning, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-gray-500 mt-0.5">•</span>
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Deposit Impact */}
          {depositAmount && depositAmount > 0n && (
            <div className="flex items-center gap-2 p-2 bg-black/20 rounded text-xs text-gray-300">
              <Zap size={14} className="text-indigo-400" />
              <span>
                Deposit would bring utilization to{" "}
                <span className="font-semibold">
                  {(
                    capacity.currentUtilization +
                    Number(depositAmount) / 100000000
                  ).toFixed(1)}
                </span>
                %
              </span>
            </div>
          )}

          {/* Recommendation */}
          {capacity.recommendedMaxDeposit > 0n && (
            <p className="text-xs text-gray-400 mt-2">
              Recommended max deposit:{" "}
              <span className="font-semibold text-gray-300">
                {(Number(capacity.recommendedMaxDeposit) / 1000000).toFixed(2)}{" "}
                USDC
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
