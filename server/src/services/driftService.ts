import { PrismaClient } from "@prisma/client";
import { TARGET_ALLOCATIONS } from "../config/targetAllocations";
import { dispatchDriftAlert } from "./alertsService";

const prisma = new PrismaClient();

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
  }
}
