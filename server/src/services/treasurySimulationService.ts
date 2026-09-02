/**
 * Treasury Allocation Simulation Service
 *
 * Computes projected yield, liquidity risk, concentration, and rotation cost
 * for a proposed multi-position treasury deployment.
 */
import type { SimulationWarning } from "../../../shared/types/simulationWarning";
import { validateAllocationsPayload } from "./allocationValidation";

// Re-export for consumers.
export type { SimulationWarning } from "../../../shared/types/simulationWarning";

export interface AllocationPosition {
  vaultId: string;
  vaultName: string;
  allocationPct: number;
  apy: number;
  tvlUsd: number;
  riskScore: number;
  rotationCostPct: number;
}

export interface TreasuryScenario {
  id: string;
  name: string;
  totalCapitalUsd: number;
  allocations: AllocationPosition[];
  createdAt: string;
}

export interface SimulationResult {
  scenarioId: string;
  scenarioName: string;
  projectedYieldPct: number;
  projectedYieldUsd: number;
  totalRotationCostUsd: number;
  liquidityRiskScore: number;
  /** @deprecated Use `warnings` for structured warning data. Kept for backwards compatibility. */
  concentrationWarnings: string[];
  /** Structured warnings with severity, affected field, and remediation text. */
  warnings: SimulationWarning[];
  allocationBreakdown: Array<{
    vaultId: string;
    vaultName: string;
    allocationPct: number;
    capitalUsd: number;
    projectedYieldUsd: number;
  }>;
}

export function isValidAllocationPayload(allocations: unknown): boolean {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return false;
  }

  for (const item of allocations) {
    if (!item || typeof item !== 'object') return false;
    const p = item as Record<string, unknown>;
    if (typeof p.vaultId !== 'string' || p.vaultId.trim().length === 0) return false;
    if (typeof p.vaultName !== 'string') return false;
    if (!Number.isFinite(p.allocationPct)) return false;
    if (!Number.isFinite(p.apy)) return false;
    if (!Number.isFinite(p.tvlUsd)) return false;
    if (!Number.isFinite(p.riskScore)) return false;
    if (!Number.isFinite(p.rotationCostPct)) return false;
  }

  const totalPct = (allocations as Array<{ allocationPct: number }>).reduce(
    (sum, item) => sum + (item.allocationPct || 0),
    0,
  );
  return Math.abs(totalPct - 100) <= 0.01;
}

export class TreasuryValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TreasuryValidationError';
  }
}

export function assertValidScenarioInput(body: unknown): TreasuryScenario {
  if (!body || typeof body !== 'object') {
    throw new TreasuryValidationError(
      'invalid_request',
      'Request body must be a JSON object.',
    );
  }

  const payload = body as Record<string, unknown>;

  if (typeof payload.id !== 'string' || payload.id.trim().length === 0) {
    throw new TreasuryValidationError(
      'invalid_id',
      'Field "id" is required and must be a non-empty string.',
      400,
      { field: 'id' },
    );
  }

  if (typeof payload.name !== 'string' || payload.name.trim().length === 0) {
    throw new TreasuryValidationError(
      'invalid_name',
      'Field "name" is required and must be a non-empty string.',
      400,
      { field: 'name' },
    );
  }

  if (!Number.isFinite((payload as any).totalCapitalUsd) || (payload as any).totalCapitalUsd < 0) {
    throw new TreasuryValidationError(
      'invalid_totalCapitalUsd',
      'Field "totalCapitalUsd" is required and must be a finite number >= 0.',
      400,
      { field: 'totalCapitalUsd' },
    );
  }

  if (!Array.isArray((payload as any).allocations) || (payload as any).allocations.length === 0) {
    throw new TreasuryValidationError(
      'invalid_allocations',
      'Field "allocations" is required and must be a non-empty array.',
      400,
      { field: 'allocations' },
    );
  }

  const allocations: AllocationPosition[] = (payload as any).allocations;

  for (const [idx, item] of allocations.entries()) {
    if (!item || typeof item !== 'object') {
      throw new TreasuryValidationError(
        'invalid_allocation_item',
        `allocations[${idx}] must be an object.`,
        400,
        { index: idx },
      );
    }

    const missing: string[] = [];
    if (typeof item.vaultId !== 'string' || item.vaultId.trim().length === 0) missing.push('vaultId');
    if (typeof item.vaultName !== 'string') missing.push('vaultName');
    if (!Number.isFinite((item as any).allocationPct)) missing.push('allocationPct');
    if (!Number.isFinite((item as any).apy)) missing.push('apy');
    if (!Number.isFinite((item as any).tvlUsd)) missing.push('tvlUsd');
    if (!Number.isFinite((item as any).riskScore)) missing.push('riskScore');
    if (!Number.isFinite((item as any).rotationCostPct)) missing.push('rotationCostPct');

    if (missing.length > 0) {
      throw new TreasuryValidationError(
        'invalid_allocation',
        `allocations[${idx}] is missing required fields: ${missing.join(', ')}.`,
        400,
        { index: idx, missingFields: missing },
      );
    }
  }

  const validation = validateAllocationsPayload(allocations);
  if (!validation.valid) {
    throw new TreasuryValidationError(
      'allocation_validation_failed',
      'Allocation validation failed.',
      422,
      { fieldErrors: validation.errors },
    );
  }

  const totalAllocationPct = allocations.reduce((sum, item) => sum + (item.allocationPct as number), 0);
  if (Math.abs(totalAllocationPct - 100) > 0.01) {
    throw new TreasuryValidationError(
      'allocation_total_mismatch',
      'Allocation percentages must sum to 100.',
      400,
      { allocationTotalPct: totalAllocationPct },
    );
  }

  return {
    id: String(payload.id).trim(),
    name: String(payload.name).trim(),
    totalCapitalUsd: Number((payload as any).totalCapitalUsd),
    allocations,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : new Date().toISOString(),
  };
}

const CONCENTRATION_THRESHOLD = 0.5;
const RESERVE_BREACH_THRESHOLD_PCT = 0.1;
const NEGATIVE_CASHFLOW_THRESHOLD_USD = 0;

const scenarioStore = new Map<string, TreasuryScenario>();

export function simulateTreasury(scenario: TreasuryScenario): SimulationResult {
  const { id, name, totalCapitalUsd, allocations } = scenario;

  const legacyWarnings: string[] = [];
  const warnings: SimulationWarning[] = [];

  let projectedYieldUsd = 0;
  let totalRotationCostUsd = 0;
  let weightedRisk = 0;

  const breakdown = allocations.map((pos) => {
    const pct = pos.allocationPct / 100;
    const capitalUsd = totalCapitalUsd * pct;
    const yieldUsd = capitalUsd * (pos.apy / 100);
    const rotationCost = capitalUsd * (pos.rotationCostPct / 100);

    projectedYieldUsd += yieldUsd;
    totalRotationCostUsd += rotationCost;
    weightedRisk += (10 - pos.riskScore) * pct;

    if (pos.allocationPct > CONCENTRATION_THRESHOLD * 100) {
      const legacyMsg = `High concentration in ${pos.vaultName} (${pos.allocationPct.toFixed(1)}%)`;
      legacyWarnings.push(legacyMsg);
      warnings.push({
        code: "HIGH_CONCENTRATION",
        severity: pos.allocationPct > 80 ? "critical" : "warning",
        affectedField: `allocations[${pos.vaultId}].allocationPct`,
        message: legacyMsg,
        remediation: `Reduce the allocation to ${pos.vaultName} below ${(CONCENTRATION_THRESHOLD * 100).toFixed(0)}% to lower single-vault concentration risk.`,
      });
    }

    return {
      vaultId: pos.vaultId,
      vaultName: pos.vaultName,
      allocationPct: pos.allocationPct,
      capitalUsd,
      projectedYieldUsd: yieldUsd,
    };
  });

  const projectedYieldPct =
    totalCapitalUsd > 0 ? (projectedYieldUsd / totalCapitalUsd) * 100 : 0;

  const liquidityRiskScore = Math.min(10, Math.max(0, weightedRisk));

  const netYieldUsd = projectedYieldUsd - totalRotationCostUsd;
  if (netYieldUsd < NEGATIVE_CASHFLOW_THRESHOLD_USD) {
    const msg = `Net yield is negative ($${netYieldUsd.toFixed(2)}) — rotation costs exceed projected yield`;
    legacyWarnings.push(msg);
    warnings.push({
      code: "NEGATIVE_NET_YIELD",
      severity: "critical",
      affectedField: "totalRotationCostUsd",
      message: msg,
      remediation: "Reduce rotation costs or increase yield by adjusting allocations to lower-cost or higher-yield vaults.",
    });
  }

  return {
    scenarioId: id,
    scenarioName: name,
    projectedYieldPct: Math.round(projectedYieldPct * 100) / 100,
    projectedYieldUsd: Math.round(projectedYieldUsd * 100) / 100,
    totalRotationCostUsd: Math.round(totalRotationCostUsd * 100) / 100,
    liquidityRiskScore: Math.round(liquidityRiskScore * 100) / 100,
    concentrationWarnings: legacyWarnings,
    warnings,
    allocationBreakdown: breakdown,
  };
}

// ── Treasury Scenario Comparison & Export ──────────────────────────

export interface StressRunConfig {
  id: string;
  name: string;
  description: string;
  apyMultiplier: number;
  rotationCostMultiplier: number;
  riskScoreMultiplier: number;
  tvlMultiplier: number;
}

export const DEFAULT_STRESS_RUNS: Record<string, StressRunConfig> = {
  "yield-collapse": {
    id: "yield-collapse",
    name: "Yield Collapse (-50% APY)",
    description: "Simulates a 50% APY haircut across all positions.",
    apyMultiplier: 0.5,
    rotationCostMultiplier: 1.0,
    riskScoreMultiplier: 1.0,
    tvlMultiplier: 1.0,
  },
  "liquidity-crunch": {
    id: "liquidity-crunch",
    name: "Liquidity Crunch (+100% Cost, -50% TVL)",
    description: "Simulates 2x rotation cost friction and 50% TVL drop.",
    apyMultiplier: 0.8,
    rotationCostMultiplier: 2.0,
    riskScoreMultiplier: 0.8,
    tvlMultiplier: 0.5,
  },
  "severe-crash": {
    id: "severe-crash",
    name: "Severe Market Crash (-70% APY, 3x Cost)",
    description: "Simulates acute market stress with 70% APY reduction and 3x rotation cost.",
    apyMultiplier: 0.3,
    rotationCostMultiplier: 3.0,
    riskScoreMultiplier: 0.5,
    tvlMultiplier: 0.3,
  },
};

export interface StressRunResult {
  stressId: string;
  stressName: string;
  description: string;
  assumptions: {
    apyMultiplier: number;
    rotationCostMultiplier: number;
    riskScoreMultiplier: number;
    tvlMultiplier: number;
  };
  totals: {
    projectedYieldPct: number;
    projectedYieldUsd: number;
    totalRotationCostUsd: number;
    netYieldUsd: number;
    liquidityRiskScore: number;
    yieldDeltaUsd: number;
    yieldDeltaPct: number;
    riskScoreDelta: number;
  };
  warnings: string[];
  structuredWarnings: SimulationWarning[];
}

export interface ScenarioComparisonResult {
  exportedAt: string;
  baseline: {
    scenarioId: string;
    scenarioName: string;
    totalCapitalUsd: number;
    assumptions: {
      totalCapitalUsd: number;
      allocationCount: number;
      allocations: AllocationPosition[];
    };
    totals: {
      projectedYieldPct: number;
      projectedYieldUsd: number;
      totalRotationCostUsd: number;
      netYieldUsd: number;
      liquidityRiskScore: number;
    };
    warnings: string[];
    structuredWarnings: SimulationWarning[];
  };
  stressRuns: StressRunResult[];
  summary: {
    worstCaseYieldUsd: number;
    worstCaseNetYieldUsd: number;
    maxYieldLossUsd: number;
    maxYieldLossPct: number;
    totalWarningsCount: number;
  };
}

export function compareTreasuryScenarios(
  scenario: TreasuryScenario,
  selectedStressIds?: string[],
): ScenarioComparisonResult {
  const baselineSim = simulateTreasury(scenario);
  const baselineNetYieldUsd = Math.round((baselineSim.projectedYieldUsd - baselineSim.totalRotationCostUsd) * 100) / 100;

  const stressIds = selectedStressIds && selectedStressIds.length > 0
    ? selectedStressIds
    : Object.keys(DEFAULT_STRESS_RUNS);

  const stressResults: StressRunResult[] = [];

  for (const id of stressIds) {
    const config = DEFAULT_STRESS_RUNS[id] ?? {
      id,
      name: id,
      description: `Custom stress run ${id}`,
      apyMultiplier: 0.5,
      rotationCostMultiplier: 1.5,
      riskScoreMultiplier: 0.8,
      tvlMultiplier: 0.7,
    };

    const stressedAllocations: AllocationPosition[] = scenario.allocations.map((a) => ({
      ...a,
      apy: Math.max(0, Math.round(a.apy * config.apyMultiplier * 100) / 100),
      rotationCostPct: Math.round(a.rotationCostPct * config.rotationCostMultiplier * 100) / 100,
      riskScore: Math.max(0, Math.min(10, Math.round(a.riskScore * config.riskScoreMultiplier * 10) / 10)),
      tvlUsd: Math.max(0, Math.round(a.tvlUsd * config.tvlMultiplier)),
    }));

    const stressedScenario: TreasuryScenario = {
      ...scenario,
      allocations: stressedAllocations,
    };

    const stressSim = simulateTreasury(stressedScenario);
    const stressNetYieldUsd = Math.round((stressSim.projectedYieldUsd - stressSim.totalRotationCostUsd) * 100) / 100;
    const yieldDeltaUsd = Math.round((stressSim.projectedYieldUsd - baselineSim.projectedYieldUsd) * 100) / 100;
    const yieldDeltaPct = baselineSim.projectedYieldUsd > 0
      ? Math.round(((stressSim.projectedYieldUsd - baselineSim.projectedYieldUsd) / baselineSim.projectedYieldUsd) * 10000) / 100
      : 0;
    const riskScoreDelta = Math.round((stressSim.liquidityRiskScore - baselineSim.liquidityRiskScore) * 100) / 100;

    const stressWarnings = [...stressSim.concentrationWarnings];
    const structuredWarnings: SimulationWarning[] = [...stressSim.warnings];

    if (stressNetYieldUsd < NEGATIVE_CASHFLOW_THRESHOLD_USD) {
      const msg = `Negative cashflow: net yield is $${stressNetYieldUsd.toLocaleString()} under ${config.name}`;
      stressWarnings.push(msg);
      structuredWarnings.push({
        code: "NEGATIVE_CASHFLOW",
        severity: "critical",
        affectedField: "netYieldUsd",
        message: msg,
        remediation: "Reduce exposure to high-cost positions or increase capital reserves to withstand market stress.",
      });
    } else if (yieldDeltaPct <= -50) {
      const msg = `Severe yield reduction (${yieldDeltaPct.toFixed(1)}%) under ${config.name}`;
      stressWarnings.push(msg);
      structuredWarnings.push({
        code: "SEVERE_YIELD_REDUCTION",
        severity: "warning",
        affectedField: "projectedYieldUsd",
        message: msg,
        remediation: "Consider diversifying into more stable yield sources to reduce sensitivity to market stress.",
      });
    }

    const reserveRatio = baselineSim.projectedYieldUsd > 0
      ? stressNetYieldUsd / baselineSim.projectedYieldUsd
      : stressNetYieldUsd >= 0 ? 1 : -1;

    if (reserveRatio < RESERVE_BREACH_THRESHOLD_PCT && stressNetYieldUsd >= 0) {
      const msg = `Reserve breach: net yield falls to ${(reserveRatio * 100).toFixed(1)}% of baseline under ${config.name}`;
      stressWarnings.push(msg);
      structuredWarnings.push({
        code: "RESERVE_BREACH",
        severity: "warning",
        affectedField: "netYieldUsd",
        message: msg,
        remediation: "Increase reserve buffer or reduce allocation to volatile positions to maintain safe reserve levels.",
      });
    }

    stressResults.push({
      stressId: config.id,
      stressName: config.name,
      description: config.description,
      assumptions: {
        apyMultiplier: config.apyMultiplier,
        rotationCostMultiplier: config.rotationCostMultiplier,
        riskScoreMultiplier: config.riskScoreMultiplier,
        tvlMultiplier: config.tvlMultiplier,
      },
      totals: {
        projectedYieldPct: stressSim.projectedYieldPct,
        projectedYieldUsd: stressSim.projectedYieldUsd,
        totalRotationCostUsd: stressSim.totalRotationCostUsd,
        netYieldUsd: stressNetYieldUsd,
        liquidityRiskScore: stressSim.liquidityRiskScore,
        yieldDeltaUsd,
        yieldDeltaPct,
        riskScoreDelta,
      },
      warnings: stressWarnings,
      structuredWarnings,
    });
  }

  let worstCaseYieldUsd = baselineSim.projectedYieldUsd;
  let worstCaseNetYieldUsd = baselineNetYieldUsd;
  let totalWarningsCount = baselineSim.concentrationWarnings.length;

  for (const sr of stressResults) {
    if (sr.totals.projectedYieldUsd < worstCaseYieldUsd) {
      worstCaseYieldUsd = sr.totals.projectedYieldUsd;
    }
    if (sr.totals.netYieldUsd < worstCaseNetYieldUsd) {
      worstCaseNetYieldUsd = sr.totals.netYieldUsd;
    }
    totalWarningsCount += sr.warnings.length;
  }

  const maxYieldLossUsd = Math.round((baselineSim.projectedYieldUsd - worstCaseYieldUsd) * 100) / 100;
  const maxYieldLossPct = baselineSim.projectedYieldUsd > 0
    ? Math.round((maxYieldLossUsd / baselineSim.projectedYieldUsd) * 10000) / 100
    : 0;

  return {
    exportedAt: new Date().toISOString(),
    baseline: {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      totalCapitalUsd: scenario.totalCapitalUsd,
      assumptions: {
        totalCapitalUsd: scenario.totalCapitalUsd,
        allocationCount: scenario.allocations.length,
        allocations: scenario.allocations,
      },
      totals: {
        projectedYieldPct: baselineSim.projectedYieldPct,
        projectedYieldUsd: baselineSim.projectedYieldUsd,
        totalRotationCostUsd: baselineSim.totalRotationCostUsd,
        netYieldUsd: baselineNetYieldUsd,
        liquidityRiskScore: baselineSim.liquidityRiskScore,
      },
      warnings: baselineSim.concentrationWarnings,
      structuredWarnings: baselineSim.warnings,
    },
    stressRuns: stressResults,
    summary: {
      worstCaseYieldUsd,
      worstCaseNetYieldUsd,
      maxYieldLossUsd,
      maxYieldLossPct,
      totalWarningsCount,
    },
  };
}

export function exportComparisonJSON(comparison: ScenarioComparisonResult): string {
  return JSON.stringify(comparison, null, 2);
}

export function exportComparisonCSV(comparison: ScenarioComparisonResult): string {
  const lines: string[] = [];

  lines.push("# Treasury Scenario Comparison Report");
  lines.push(`# Scenario Name: ${comparison.baseline.scenarioName}`);
  lines.push(`# Scenario ID: ${comparison.baseline.scenarioId}`);
  lines.push(`# Total Capital (USD): $${comparison.baseline.totalCapitalUsd.toLocaleString()}`);
  lines.push(`# Exported At: ${comparison.exportedAt}`);
  lines.push("");

  lines.push("# SUMMARY");
  lines.push("Metric,Value");
  lines.push(`Baseline Projected Yield ($),$${comparison.baseline.totals.projectedYieldUsd.toFixed(2)}`);
  lines.push(`Baseline Net Yield ($),$${comparison.baseline.totals.netYieldUsd.toFixed(2)}`);
  lines.push(`Worst-Case Projected Yield ($),$${comparison.summary.worstCaseYieldUsd.toFixed(2)}`);
  lines.push(`Worst-Case Net Yield ($),$${comparison.summary.worstCaseNetYieldUsd.toFixed(2)}`);
  lines.push(`Max Yield Loss ($),$${comparison.summary.maxYieldLossUsd.toFixed(2)}`);
  lines.push(`Max Yield Loss (%),${comparison.summary.maxYieldLossPct.toFixed(2)}%`);
  lines.push(`Total Warnings Count,${comparison.summary.totalWarningsCount}`);
  lines.push("");

  lines.push("# RUN COMPARISON");
  lines.push("Run ID,Run Name,Run Type,Projected Yield (%),Projected Yield ($),Rotation Cost ($),Net Yield ($),Liquidity Risk Score,Yield Delta ($),Yield Delta (%),Warnings Count,Warning Details");

  const b = comparison.baseline;
  const bWarningsFormatted = b.warnings.map((w) => `${w.replace(/"/g, '""')}`).join("; ");
  lines.push(
    [
      `"baseline"`,
      `"${b.scenarioName.replace(/"/g, '""')}"`,
      `"Baseline"`,
      b.totals.projectedYieldPct.toFixed(2),
      b.totals.projectedYieldUsd.toFixed(2),
      b.totals.totalRotationCostUsd.toFixed(2),
      b.totals.netYieldUsd.toFixed(2),
      b.totals.liquidityRiskScore.toFixed(2),
      "0.00",
      "0.00",
      b.warnings.length,
      bWarningsFormatted ? `"${bWarningsFormatted}"` : '""',
    ].join(",")
  );

  for (const sr of comparison.stressRuns) {
    const sWarningsFormatted = sr.warnings.map((w) => `${w.replace(/"/g, '""')}`).join("; ");
    lines.push(
      [
        `"${sr.stressId}"`,
        `"${sr.stressName.replace(/"/g, '""')}"`,
        `"Stress"`,
        sr.totals.projectedYieldPct.toFixed(2),
        sr.totals.projectedYieldUsd.toFixed(2),
        sr.totals.totalRotationCostUsd.toFixed(2),
        sr.totals.netYieldUsd.toFixed(2),
        sr.totals.liquidityRiskScore.toFixed(2),
        sr.totals.yieldDeltaUsd.toFixed(2),
        sr.totals.yieldDeltaPct.toFixed(2),
        sr.warnings.length,
        sWarningsFormatted ? `"${sWarningsFormatted}"` : '""',
      ].join(",")
    );
  }

  lines.push("");
  lines.push("# ALLOCATION ASSUMPTIONS");
  lines.push("Vault ID,Vault Name,Allocation (%),APY (%),TVL ($),Risk Score,Rotation Cost (%)");

  for (const alloc of comparison.baseline.assumptions.allocations) {
    lines.push(
      [
        `"${alloc.vaultId}"`,
        `"${alloc.vaultName.replace(/"/g, '""')}"`,
        alloc.allocationPct.toFixed(2),
        alloc.apy.toFixed(2),
        alloc.tvlUsd.toFixed(2),
        alloc.riskScore.toFixed(2),
        alloc.rotationCostPct.toFixed(2),
      ].join(",")
    );
  }

  return lines.join("\n");
}

export function saveScenario(scenario: TreasuryScenario): void {
  scenarioStore.set(scenario.id, scenario);
}

export function getScenario(id: string): TreasuryScenario | undefined {
  return scenarioStore.get(id);
}

export function listScenarios(): TreasuryScenario[] {
  return Array.from(scenarioStore.values());
}

export function deleteScenario(id: string): boolean {
  return scenarioStore.delete(id);
}

// ── Cashflow Import ──────────────────────────────────────────────

export const SUPPORTED_ASSETS = ["XLM", "USDC", "ETH", "BTC"] as const;
export type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];

export const CASHFLOW_CATEGORIES = [
  "interest",
  "deposit",
  "withdrawal",
  "fee",
  "transfer",
  "other",
] as const;
export type CashflowCategory = (typeof CASHFLOW_CATEGORIES)[number];

export interface CashflowRow {
  id: string;
  date: string;
  asset: string;
  amount: number;
  direction: "inflow" | "outflow";
  category: string;
  memo?: string;
}

export interface CashflowRowError {
  rowIndex: number;
  field: string;
  code: string;
  message: string;
}

export interface CashflowRowWarning {
  rowIndex: number;
  field: string;
  code: string;
  message: string;
}

export interface CashflowImportPreview {
  validRows: CashflowRow[];
  errors: CashflowRowError[];
  warnings: CashflowRowWarning[];
  summary: {
    totalRows: number;
    validCount: number;
    errorCount: number;
    warningCount: number;
    totalInflow: number;
    totalOutflow: number;
    netFlow: number;
  };
}

type RowValidationResult = {
  row: CashflowRow | null;
  errors: CashflowRowError[];
  warnings: CashflowRowWarning[];
};

function parseDateSafe(raw: string): Date | null {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d;
}

function validateSingleCashflowRow(
  raw: unknown,
  rowIndex: number,
  knownIds: Set<string>,
): RowValidationResult {
  const errors: CashflowRowError[] = [];
  const warnings: CashflowRowWarning[] = [];

  if (!raw || typeof raw !== "object") {
    errors.push({
      rowIndex,
      field: "_root",
      code: "not_an_object",
      message: `Row ${rowIndex} must be an object.`,
    });
    return { row: null, errors, warnings };
  }

  const obj = raw as Record<string, unknown>;
  const row: Partial<CashflowRow> = {};

  // id
  if (typeof obj.id !== "string" || obj.id.trim().length === 0) {
    errors.push({
      rowIndex,
      field: "id",
      code: "missing_id",
      message: `Row ${rowIndex}: "id" is required and must be a non-empty string.`,
    });
  } else if (knownIds.has(obj.id.trim())) {
    errors.push({
      rowIndex,
      field: "id",
      code: "duplicate_id",
      message: `Row ${rowIndex}: duplicate id "${obj.id}".`,
    });
  } else {
    row.id = obj.id.trim();
    knownIds.add(row.id);
  }

  // date
  if (typeof obj.date !== "string" || obj.date.trim().length === 0) {
    errors.push({
      rowIndex,
      field: "date",
      code: "missing_date",
      message: `Row ${rowIndex}: "date" is required and must be a string.`,
    });
  } else {
    const parsed = parseDateSafe(obj.date);
    if (!parsed) {
      errors.push({
        rowIndex,
        field: "date",
        code: "invalid_date",
        message: `Row ${rowIndex}: "${obj.date}" is not a valid date.`,
      });
    } else if (parsed > new Date()) {
      warnings.push({
        rowIndex,
        field: "date",
        code: "future_date",
        message: `Row ${rowIndex}: date "${obj.date}" is in the future.`,
      });
      row.date = obj.date;
    } else {
      row.date = obj.date;
    }
  }

  // asset
  if (typeof obj.asset !== "string" || obj.asset.trim().length === 0) {
    errors.push({
      rowIndex,
      field: "asset",
      code: "missing_asset",
      message: `Row ${rowIndex}: "asset" is required.`,
    });
  } else {
    const asset = obj.asset.trim().toUpperCase();
    if (!(SUPPORTED_ASSETS as readonly string[]).includes(asset)) {
      errors.push({
        rowIndex,
        field: "asset",
        code: "unsupported_asset",
        message: `Row ${rowIndex}: "${obj.asset}" is not supported. Supported: ${SUPPORTED_ASSETS.join(", ")}.`,
      });
    } else {
      row.asset = asset;
    }
  }

  // amount
  if (obj.amount === undefined || obj.amount === null) {
    errors.push({
      rowIndex,
      field: "amount",
      code: "missing_amount",
      message: `Row ${rowIndex}: "amount" is required.`,
    });
  } else if (typeof obj.amount !== "number" || !Number.isFinite(obj.amount)) {
    errors.push({
      rowIndex,
      field: "amount",
      code: "invalid_amount",
      message: `Row ${rowIndex}: "amount" must be a finite number.`,
    });
  } else if ((obj.amount as number) <= 0) {
    errors.push({
      rowIndex,
      field: "amount",
      code: "negative_amount",
      message: `Row ${rowIndex}: "amount" must be greater than 0.`,
    });
  } else {
    row.amount = obj.amount as number;
  }

  // direction
  if (typeof obj.direction !== "string") {
    errors.push({
      rowIndex,
      field: "direction",
      code: "missing_direction",
      message: `Row ${rowIndex}: "direction" is required.`,
    });
  } else {
    const dir = obj.direction.toLowerCase();
    if (dir !== "inflow" && dir !== "outflow") {
      errors.push({
        rowIndex,
        field: "direction",
        code: "invalid_direction",
        message: `Row ${rowIndex}: "direction" must be "inflow" or "outflow".`,
      });
    } else {
      row.direction = dir;
    }
  }

  // category
  if (typeof obj.category !== "string" || obj.category.trim().length === 0) {
    errors.push({
      rowIndex,
      field: "category",
      code: "missing_category",
      message: `Row ${rowIndex}: "category" is required.`,
    });
  } else {
    const cat = obj.category.toLowerCase();
    if (!(CASHFLOW_CATEGORIES as readonly string[]).includes(cat)) {
      errors.push({
        rowIndex,
        field: "category",
        code: "invalid_category",
        message: `Row ${rowIndex}: "${obj.category}" is not a valid category. Valid: ${CASHFLOW_CATEGORIES.join(", ")}.`,
      });
    } else {
      row.category = cat;
    }
  }

  // memo (optional)
  if (obj.memo !== undefined && obj.memo !== null) {
    row.memo = String(obj.memo);
  }

  const hasErrors = errors.length > 0;
  return {
    row: hasErrors ? null : (row as CashflowRow),
    errors,
    warnings,
  };
}

function computeSummary(
  validRows: CashflowRow[],
): CashflowImportPreview["summary"] {
  let totalInflow = 0;
  let totalOutflow = 0;
  for (const r of validRows) {
    if (r.direction === "inflow") totalInflow += r.amount;
    else totalOutflow += r.amount;
  }
  return {
    totalRows: 0, // filled by caller
    validCount: validRows.length,
    errorCount: 0, // filled by caller
    warningCount: 0, // filled by caller
    totalInflow,
    totalOutflow,
    netFlow: totalInflow - totalOutflow,
  };
}

export function previewImport(rows: unknown[]): CashflowImportPreview {
  const knownIds = new Set<string>();
  let allErrors: CashflowRowError[] = [];
  let allWarnings: CashflowRowWarning[] = [];
  const validRows: CashflowRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const result = validateSingleCashflowRow(rows[i], i, knownIds);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
    if (result.row) validRows.push(result.row);
  }

  const summary = computeSummary(validRows);
  summary.totalRows = rows.length;
  summary.errorCount = allErrors.length;
  summary.warningCount = allWarnings.length;

  return { validRows, errors: allErrors, warnings: allWarnings, summary };
}