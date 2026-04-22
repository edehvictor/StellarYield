import { Horizon } from "@stellar/stellar-sdk";

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
}
