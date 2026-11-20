import { Horizon } from "@stellar/stellar-sdk";
import { enqueueAdapterRequest } from "../agents/adapterRetryQueue";

export interface NetworkSnapshot {
  ledgerSequence: number;
  closedAt: string;
  network: "mainnet" | "testnet";
}

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";

const networkLabel = HORIZON_URL.includes("testnet") ? "testnet" : "mainnet";

const horizonServer = new Horizon.Server(HORIZON_URL);

export async function fetchNetworkSnapshot(): Promise<NetworkSnapshot> {
  // STELLAR_SKIP_RETRIES can be set in smoke/integration tests to avoid long
  // retry delays when there is no real Horizon endpoint available.
  const skipRetries = process.env.STELLAR_SKIP_RETRIES === "true";
  const maxRetries = skipRetries ? 0 : 3;
  const initialDelayMs = skipRetries ? 50 : 1000;
  const timeoutMs = skipRetries
    ? 300
    : parseInt(process.env.STELLAR_HORIZON_TIMEOUT_MS ?? "10000", 10);

  return enqueueAdapterRequest(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await horizonServer.ledgers().order("desc").limit(1).call();
        const latestLedger = response.records[0];

        if (!latestLedger) {
          throw new Error("No Stellar ledger data returned from Horizon.");
        }

        return {
          ledgerSequence: latestLedger.sequence,
          closedAt: latestLedger.closed_at,
          network: networkLabel,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    "horizon-network",
    { maxRetries, initialDelayMs, maxDelayMs: 30_000 },
  );
}
