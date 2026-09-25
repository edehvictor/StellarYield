import { TARGET_ALLOCATIONS } from "../config/targetAllocations";

export type FieldError = {
  field: string;
  index?: number;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
};

export const SUM_TOLERANCE_PCT = 0.01; // percent points (e.g., 0.01 means 0.01%)
export const MIN_NONZERO_ALLOCATION_PCT = 0.01; // percent (0.01% considered dust)

export function validateAllocationsPayload(allocations: unknown): { valid: boolean; errors: FieldError[] } {
  const errors: FieldError[] = [];

  if (!Array.isArray(allocations) || allocations.length === 0) {
    errors.push({ field: "allocations", code: "required", message: "allocations must be a non-empty array" });
    return { valid: false, errors };
  }

  let total = 0;

  for (let i = 0; i < allocations.length; i++) {
    const item = allocations[i] as any;
    if (!item || typeof item !== "object") {
      errors.push({ field: `allocations[${i}]`, index: i, code: "not_object", message: "Allocation must be an object" });
      continue;
    }

    if (typeof item.vaultId !== "string" || item.vaultId.trim().length === 0) {
      errors.push({ field: `allocations[${i}].vaultId`, index: i, code: "missing", message: "vaultId is required" });
    }

    if (!Number.isFinite(item.allocationPct)) {
      errors.push({ field: `allocations[${i}].allocationPct`, index: i, code: "missing", message: "allocationPct is required and must be a finite number" });
    } else {
      const pct = Number(item.allocationPct);
      total += pct;
      if (pct < 0) {
        errors.push({ field: `allocations[${i}].allocationPct`, index: i, code: "negative", message: "allocationPct must not be negative", meta: { value: pct } });
      } else if (pct > 0 && pct < MIN_NONZERO_ALLOCATION_PCT) {
        errors.push({ field: `allocations[${i}].allocationPct`, index: i, code: "dust", message: `allocationPct is too small (dust). Minimum non-zero allocation is ${MIN_NONZERO_ALLOCATION_PCT}%`, meta: { value: pct } });
      }
    }
  }

  // Sum tolerance: allow minor rounding drifts
  if (Math.abs(total - 100) > SUM_TOLERANCE_PCT) {
    errors.push({ field: "allocations", code: "sum_mismatch", message: `Allocations must sum to 100. Got ${total.toFixed(6)}%`, meta: { totalPct: total } });
  }

  // Drift checks against configured targets
  for (const cfg of TARGET_ALLOCATIONS) {
    const provided = (allocations as any[]).find((a) => String(a.vaultId) === cfg.vaultId);
    if (!provided) continue;
    const providedPct = Number(provided.allocationPct) / 100;
    const drift = Math.abs(providedPct - cfg.targetWeight);
    if (drift >= cfg.driftThreshold) {
      errors.push({
        field: `allocations.${cfg.vaultId}.allocationPct`,
        code: "drift_exceeds_threshold",
        message: `Allocation for vault ${cfg.vaultId} deviates from target by ${Math.round(drift * 10000) / 100}% which exceeds configured threshold of ${Math.round(cfg.driftThreshold * 10000) / 100}%`,
        meta: { vaultId: cfg.vaultId, providedPct, targetWeight: cfg.targetWeight, drift, driftThreshold: cfg.driftThreshold },
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export default validateAllocationsPayload;
