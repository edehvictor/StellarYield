/**
 * Treasury Allocation Simulation Service
 *
 * Computes projected yield, liquidity risk, concentration, and rotation cost
 * for a proposed multi-position treasury deployment.
 */

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
  concentrationWarnings: string[];
  allocationBreakdown: Array<{
    vaultId: string;
    vaultName: string;
    allocationPct: number;
    capitalUsd: number;
    projectedYieldUsd: number;
  }>;
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

const scenarioStore = new Map<string, TreasuryScenario>();

export function simulateTreasury(scenario: TreasuryScenario): SimulationResult {
  const { id, name, totalCapitalUsd, allocations } = scenario;

  const warnings: string[] = [];

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
      warnings.push(
        `High concentration in ${pos.vaultName} (${pos.allocationPct.toFixed(1)}%)`,
      );
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

  return {
    scenarioId: id,
    scenarioName: name,
    projectedYieldPct: Math.round(projectedYieldPct * 100) / 100,
    projectedYieldUsd: Math.round(projectedYieldUsd * 100) / 100,
    totalRotationCostUsd: Math.round(totalRotationCostUsd * 100) / 100,
    liquidityRiskScore: Math.round(liquidityRiskScore * 100) / 100,
    concentrationWarnings: warnings,
    allocationBreakdown: breakdown,
  };
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