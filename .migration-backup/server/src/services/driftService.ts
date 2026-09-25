import { PrismaClient } from "@prisma/client";
import { TARGET_ALLOCATIONS } from "../config/targetAllocations";
import { dispatchDriftAlert } from "./alertsService";
import {
  driftAnomalyGrouper,
  DriftSignal,
  GroupedAnomaly,
  GroupingOptions,
  AnomalySeverityBand,
} from "./driftAnomalyGrouper";

const prisma = new PrismaClient();

let _activeGroupedAnomalies: GroupedAnomaly[] = [];

export class DriftService {
  /**
   * Evaluates the drift events and triggers alerts when a vault allocation drifts 
   * beyond the configuration bounds.
   * 
   * @param vaultValuesUsd - A mapping of vaultId to its current total value in USD.
   */
  public static async evaluateDriftEvents(vaultValuesUsd: Record<string, number>): Promise<void> {
    const totalUsd = Object.values(vaultValuesUsd).reduce((a, b) => a + b, 0);
    if (totalUsd === 0) return;

    for (const config of TARGET_ALLOCATIONS) {
      const vaultId = config.vaultId;
      const actualValue = vaultValuesUsd[vaultId] || 0;
      const actualWeight = actualValue / totalUsd;
      const driftAmount = actualWeight - config.targetWeight;
      const absoluteDrift = Math.abs(driftAmount);
      
      const isDrifting = absoluteDrift >= config.driftThreshold;
      
      // Find active unresolved drift event for this vault
      const unrecoveredEvent = await prisma.driftEvent.findFirst({
        where: { vaultId, isRecovered: false },
        orderBy: { createdAt: "desc" },
      });

      if (isDrifting && !unrecoveredEvent) {
        // Create new drift event
        await prisma.driftEvent.create({
          data: {
            vaultId,
            targetWeight: config.targetWeight,
            actualWeight,
            driftAmount,
            isRecovered: false,
          },
        });
        
        const state = driftAmount > 0 ? "overweight" : "underweight";
        await dispatchDriftAlert(vaultId, config.targetWeight, actualWeight, driftAmount, state);
        
      } else if (!isDrifting && unrecoveredEvent) {
        // Recovered from drift
        await prisma.driftEvent.update({
          where: { id: unrecoveredEvent.id },
          data: { isRecovered: true, resolvedAt: new Date() },
        });

        await dispatchDriftAlert(vaultId, config.targetWeight, actualWeight, driftAmount, "recovered");
      }
    }

    // Refresh active grouped anomalies from current state
    const vaultSignals = this.convertVaultDriftToSignals(vaultValuesUsd);
    _activeGroupedAnomalies = this.groupSignals(vaultSignals);
  }

  /**
   * Converts raw vault USD values into standardized DriftSignals.
   */
  public static convertVaultDriftToSignals(
    vaultValuesUsd: Record<string, number>,
    now: string | number = new Date().toISOString()
  ): DriftSignal[] {
    const totalUsd = Object.values(vaultValuesUsd).reduce((a, b) => a + b, 0);
    if (totalUsd === 0) return [];

    const signals: DriftSignal[] = [];

    for (const config of TARGET_ALLOCATIONS) {
      const vaultId = config.vaultId;
      const actualValue = vaultValuesUsd[vaultId] || 0;
      const actualWeight = actualValue / totalUsd;
      const driftAmount = actualWeight - config.targetWeight;
      const absoluteDrift = Math.abs(driftAmount);

      if (absoluteDrift >= config.driftThreshold) {
        let severity: AnomalySeverityBand = "MEDIUM";
        if (absoluteDrift >= config.driftThreshold * 3) {
          severity = "CRITICAL";
        } else if (absoluteDrift >= config.driftThreshold * 2) {
          severity = "HIGH";
        }

        signals.push({
          id: `vault_allocation_drift_${vaultId}_${typeof now === "number" ? now : new Date(now).getTime()}`,
          source: "vault",
          subSource: "vault_allocation",
          asset: vaultId,
          metric: "allocation_drift",
          currentValue: Math.round(actualWeight * 10000) / 10000,
          expectedValue: config.targetWeight,
          deviation: Math.round(driftAmount * 10000) / 10000,
          severity,
          timestamp: now,
          metadata: {
            actualValueUsd: actualValue,
            totalUsd,
            targetWeight: config.targetWeight,
            driftThreshold: config.driftThreshold,
            direction: driftAmount > 0 ? "overweight" : "underweight",
          },
        });
      }
    }

    return signals;
  }

  /**
   * Group arbitrary drift signals across portfolio, vault, and strategy services.
   */
  public static groupSignals(signals: DriftSignal[], options?: GroupingOptions): GroupedAnomaly[] {
    return driftAnomalyGrouper.groupSignals(signals, options);
  }

  /**
   * Evaluates current vault USD allocations and external signals (from portfolio & strategy),
   * groups related anomalies, updates database records, and returns the grouped anomaly report.
   */
  public static async evaluateGroupedDriftEvents(
    vaultValuesUsd: Record<string, number>,
    externalSignals: DriftSignal[] = [],
    options?: GroupingOptions
  ): Promise<GroupedAnomaly[]> {
    // Run the standard evaluation loop for db records & legacy alert emails
    await this.evaluateDriftEvents(vaultValuesUsd);

    const vaultSignals = this.convertVaultDriftToSignals(vaultValuesUsd);
    const combinedSignals = [...vaultSignals, ...externalSignals];

    const grouped = this.groupSignals(combinedSignals, options);
    _activeGroupedAnomalies = grouped;

    return grouped;
  }

  /**
   * Returns the current active grouped anomalies.
   */
  public static getActiveGroupedAnomalies(): GroupedAnomaly[] {
    return [..._activeGroupedAnomalies];
  }

  /**
   * Clears the current active grouped anomalies (useful for tests and reset).
   */
  public static clearActiveGroupedAnomalies(): void {
    _activeGroupedAnomalies = [];
  }
}

export { DriftSignal, GroupedAnomaly, GroupingOptions, AnomalySeverityBand };
