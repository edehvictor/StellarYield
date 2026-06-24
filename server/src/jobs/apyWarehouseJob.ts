import cron from "node-cron";
import { PROTOCOLS } from "../config/protocols";
import { ingestSnapshot } from "../services/apyWarehouseService";
import { getYieldData } from "../services/yieldService";

/**
 * Fetches current yield data for all protocols and ingests one APY snapshot
 * per protocol into the warehouse. Idempotent — duplicate protocolId+timestamp
 * entries are silently ignored by the service.
 */
export async function runApyWarehouseJob(): Promise<void> {
  const timestamp = new Date();

  try {
    const yields = await getYieldData();

    // Build a quick lookup by protocolName so we can match to PROTOCOLS config
    const yieldByName = new Map(yields.map((y) => [y.protocolName, y]));

    const results = await Promise.allSettled(
      PROTOCOLS.map(async (protocol) => {
        const yieldData = yieldByName.get(protocol.protocolName);

        const apy =
          yieldData != null
            ? yieldData.apy
            : protocol.baseApyBps / 100;

        const tvl =
          yieldData != null
            ? yieldData.tvlUsd
            : protocol.baseTvlUsd;

        await ingestSnapshot({
          protocolId: protocol.protocolName,
          apy,
          tvl,
          timestamp,
          source: protocol.source ?? "internal",
        });
      }),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.warn(
        `[apy-warehouse-job] ${failed.length} of ${PROTOCOLS.length} protocol ingests failed.`,
        failed.map((r) => (r as PromiseRejectedResult).reason),
      );
    }

    console.info(
      `[apy-warehouse-job] Ingested ${PROTOCOLS.length - failed.length} APY snapshots at ${timestamp.toISOString()}.`,
    );
  } catch (error) {
    console.error("[apy-warehouse-job] Job run failed.", error);
  }
}

export function startApyWarehouseJob(): void {
  cron.schedule("0 * * * *", () => {
    void runApyWarehouseJob();
  });

  console.info(
    "[apy-warehouse-job] Scheduled to run every hour (minute 0).",
  );
}
