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
