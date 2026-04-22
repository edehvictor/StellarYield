import { Horizon } from "@stellar/stellar-sdk";

type FeeLevel = "low" | "average" | "high";

export interface FeeOracleResponse {
  networkPassphrase: string;
  sampleSize: number;
  utilization: {
    averageTxSetSize: number;
    maxTxSetSize: number;
    congestionRatio: number;
  };
  fees: Record<FeeLevel, number>;
  generatedAt: string;
}

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const LEDGER_SAMPLE_SIZE = Number(process.env.FEE_ORACLE_LEDGER_SAMPLE_SIZE ?? 20);
const MIN_FEE_STROOPS = Number(process.env.FEE_ORACLE_MIN_BASE_FEE ?? 100);
const CACHE_TTL_MS = Number(process.env.FEE_ORACLE_CACHE_TTL_MS ?? 30_000);

const horizon = new Horizon.Server(HORIZON_URL);

let cachedResult: FeeOracleResponse | null = null;
let cacheExpiresAt = 0;

function toSafeFee(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_FEE_STROOPS;
  return Math.max(MIN_FEE_STROOPS, Math.round(value));
}

function computePriorityFees(baseFee: number, congestionRatio: number): Record<FeeLevel, number> {
  const boundedCongestion = Math.max(0, Math.min(2, congestionRatio));
  const low = toSafeFee(baseFee * (1 + boundedCongestion * 0.25));
  const average = toSafeFee(baseFee * (1.2 + boundedCongestion * 0.45));
  const high = toSafeFee(baseFee * (1.5 + boundedCongestion * 0.8));
  return { low, average, high };
}

export async function getFeeOracleEstimate(): Promise<FeeOracleResponse> {
  const now = Date.now();
  if (cachedResult && now < cacheExpiresAt) {
    return cachedResult;
  }

  const ledgers = await horizon
    .ledgers()
    .order("desc")
    .limit(Math.min(Math.max(LEDGER_SAMPLE_SIZE, 5), 200))
    .call();

  const records = ledgers.records;
  if (records.length === 0) {
    const fallback = {
      networkPassphrase: NETWORK_PASSPHRASE,
      sampleSize: 0,
      utilization: {
        averageTxSetSize: 0,
        maxTxSetSize: 0,
        congestionRatio: 0,
      },
      fees: {
        low: MIN_FEE_STROOPS,
        average: toSafeFee(MIN_FEE_STROOPS * 1.2),
        high: toSafeFee(MIN_FEE_STROOPS * 1.5),
      },
      generatedAt: new Date().toISOString(),
    };
    cachedResult = fallback;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return fallback;
  }

  const txSetSizes = records.map((ledger) => ledger.successful_transaction_count ?? 0);
  const baseFees = records.map((ledger) => Number(ledger.base_fee_in_stroops ?? MIN_FEE_STROOPS));

  const averageTxSetSize = txSetSizes.reduce((sum, size) => sum + size, 0) / txSetSizes.length;
  const maxTxSetSize = Math.max(...txSetSizes, 1);
  const congestionRatio = averageTxSetSize / maxTxSetSize;
  const averageBaseFee = baseFees.reduce((sum, fee) => sum + fee, 0) / baseFees.length;

  const result: FeeOracleResponse = {
    networkPassphrase: NETWORK_PASSPHRASE,
    sampleSize: records.length,
    utilization: {
      averageTxSetSize,
      maxTxSetSize,
      congestionRatio,
    },
    fees: computePriorityFees(averageBaseFee, congestionRatio),
    generatedAt: new Date().toISOString(),
  };

  cachedResult = result;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return result;
}
