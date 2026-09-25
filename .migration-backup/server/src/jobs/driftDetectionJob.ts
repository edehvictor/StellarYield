import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { DriftService } from "../services/driftService";
import { TARGET_ALLOCATIONS } from "../config/targetAllocations";

const prisma = new PrismaClient();
let jobHandle: ReturnType<typeof cron.schedule> | null = null;

export function startDriftDetectionJob(schedule = "0 */4 * * *") {
  if (jobHandle) return;

  console.log(`Starting Drift Detection Job with schedule: ${schedule}`);
  
  jobHandle = cron.schedule(schedule, async () => {
    try {
      await runDriftDetection();
    } catch (error) {
      console.error("Drift Detection Job failed:", error);
    }
  });
}

export function stopDriftDetectionJob() {
  if (jobHandle) {
    jobHandle.stop();
    jobHandle = null;
    console.log("Drift Detection Job stopped");
  }
}

export async function runDriftDetection() {
  console.log("Running Drift Detection Job...");
  const vaultValuesUsd: Record<string, number> = {};

  for (const config of TARGET_ALLOCATIONS) {
    const vaultId = config.vaultId;
    const latestSnapshot = await prisma.sharePriceSnapshot.findFirst({
      where: { vaultId },
      orderBy: { snapshotAt: "desc" },
    });
    
    // Fallback to 0 if not found
    vaultValuesUsd[vaultId] = latestSnapshot?.totalAssets || 0;
  }

  await DriftService.evaluateDriftEvents(vaultValuesUsd);
  console.log("Drift Detection Job completed successfully.");
}
