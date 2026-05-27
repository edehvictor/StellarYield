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

// ── Fee Oracle Deviation Alerting ────────────────────────────────────────

export type FeeAlertLevel = 'normal' | 'warning' | 'critical';

export interface FeeDeviationAlert {
  level: FeeAlertLevel;
  currentFee: number;            // stroops, the observed average fee
  baselineFee: number;           // stroops, EMA-smoothed baseline
  deviationPct: number;          // signed: positive = above baseline
  warningThresholdPct: number;   // always WARNING_DEVIATION_PCT
  criticalThresholdPct: number;  // always CRITICAL_DEVIATION_PCT
  message: string;               // human-readable summary
  generatedAt: string;           // ISO timestamp
}

const WARNING_DEVIATION_PCT = 20;
const CRITICAL_DEVIATION_PCT = 50;
const EMA_ALPHA = 0.3; // weight given to the most recent observation

let feeBaseline: number | null = null;

/** Reset the EMA baseline (useful in tests). */
export function resetFeeBaseline(): void {
  feeBaseline = null;
}

/**
 * Pure computation of a fee deviation alert.
 * Keeps baseline tracking separate so this function can be tested without
 * module-level state.
 */
export function computeFeeDeviationAlert(
  currentFee: number,
  baselineFee: number,
): FeeDeviationAlert {
  const deviationPct =
    baselineFee > 0 ? ((currentFee - baselineFee) / baselineFee) * 100 : 0;
  const absDeviation = Math.abs(deviationPct);

  let level: FeeAlertLevel = 'normal';
  if (absDeviation >= CRITICAL_DEVIATION_PCT) {
    level = 'critical';
  } else if (absDeviation >= WARNING_DEVIATION_PCT) {
    level = 'warning';
  }

  const direction = deviationPct >= 0 ? 'above' : 'below';
  const message =
    level === 'normal'
      ? `Fees within normal range (${deviationPct.toFixed(1)}% ${direction} baseline)`
      : level === 'warning'
        ? `Fee spike: ${Math.abs(deviationPct).toFixed(1)}% ${direction} baseline — costs elevated`
        : `Critical fee spike: ${Math.abs(deviationPct).toFixed(1)}% ${direction} baseline — consider delaying transactions`;

  return {
    level,
    currentFee: Math.round(currentFee),
    baselineFee: Math.round(baselineFee),
    deviationPct: Math.round(deviationPct * 10) / 10,
    warningThresholdPct: WARNING_DEVIATION_PCT,
    criticalThresholdPct: CRITICAL_DEVIATION_PCT,
    message,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Stateful: updates the EMA baseline and returns a deviation alert.
 */
export function checkFeeDeviation(currentFee: number): FeeDeviationAlert {
  if (feeBaseline === null) {
    feeBaseline = currentFee;
  } else {
    feeBaseline = EMA_ALPHA * currentFee + (1 - EMA_ALPHA) * feeBaseline;
  }
  return computeFeeDeviationAlert(currentFee, feeBaseline);
}

/**
 * Convenience: fetch the latest fee estimate and compute a deviation alert.
 */
export async function getFeeDeviationAlert(): Promise<{
  estimate: FeeOracleResponse;
  alert: FeeDeviationAlert;
}> {
  const estimate = await getFeeOracleEstimate();
  const alert = checkFeeDeviation(estimate.fees.average);
  return { estimate, alert };
}
