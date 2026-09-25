import cron from "node-cron";
import { connectToDatabase } from "../db/database";
import { YieldSnapshotModel } from "../models/YieldSnapshot";
import { getYieldData } from "../services/yieldService";

export async function runHistoricalYieldAggregation() {
  try {
    const db = await connectToDatabase();

    if (!db) {
      console.warn(
        "Skipping historical yield snapshot because no database connection is configured.",
      );
      return;
    }

    const yields = await getYieldData();
    const snapshotAt = new Date();

    await YieldSnapshotModel.insertMany(
      yields.map((yieldRecord) => ({
        ...yieldRecord,
        fetchedAt: new Date(yieldRecord.fetchedAt),
        snapshotAt,
      })),
    );

    console.info(
      `[historical-yield-job] Stored ${yields.length} yield snapshots at ${snapshotAt.toISOString()}.`,
    );
  } catch (error) {
    console.error("[historical-yield-job] Snapshot run failed.", error);
  }
}

export function startHistoricalYieldAggregationJob() {
  cron.schedule("0 */12 * * *", () => {
    void runHistoricalYieldAggregation();
  });

  console.info(
    "[historical-yield-job] Scheduled to run every 12 hours (minute 0, every 12th hour).",
  );
}
