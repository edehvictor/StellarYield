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
  /** Buffered fees — oracle estimate + network-specific buffer applied (#1188). */
  bufferedFees: Record<FeeLevel, number>;
  /** The buffer configuration applied to produce bufferedFees. */
  feeBuffer: NetworkFeeBufferConfig;
  generatedAt: string;
}

// ── Fee Buffer Configuration (#1188) ────────────────────────────────────────

/**
 * Per-network fee buffer settings. The buffer is a multiplier applied on top
 * of the oracle estimate before presenting a quote or building a transaction.
 *
 * Rationale: Different Stellar networks have different fee behaviors.
 * - Mainnet: small conservative buffer (5 %) to ensure inclusion.
 * - Testnet: slightly larger buffer (10 %) since test fees fluctuate more.
 * - Futurenet: aggressive buffer (20 %) for an early/volatile test chain.
 *
 * Override via environment variable: NETWORK_FEE_BUFFER_<NETWORK_KEY>=<pct>
 * where <NETWORK_KEY> is one of MAINNET | TESTNET | FUTURENET | DEFAULT.
 */
export interface NetworkFeeBufferConfig {
  /** Percentage buffer added to the oracle estimate (e.g. 5 = +5 %). */
  bufferPct: number;
  /** Minimum fee in stroops after applying the buffer. */
  minFeeStroops: number;
}

const DEFAULT_BUFFER_PCT = 5;
const DEFAULT_MIN_FEE_STROOPS = 100;

function parseEnvBufferPct(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Built-in per-network defaults. Configurable via env vars.
 *
 * Network key is derived from the STELLAR_NETWORK_PASSPHRASE env var:
 *   "Public Global Stellar Network…"  → mainnet
 *   "Test SDF Network…"               → testnet
 *   "Test SDF Future Network…"        → futurenet
 */
export const NETWORK_FEE_BUFFERS: Record<string, NetworkFeeBufferConfig> = {
  mainnet: {
    bufferPct: parseEnvBufferPct("NETWORK_FEE_BUFFER_MAINNET", 5),
    minFeeStroops: DEFAULT_MIN_FEE_STROOPS,
  },
  testnet: {
    bufferPct: parseEnvBufferPct("NETWORK_FEE_BUFFER_TESTNET", 10),
    minFeeStroops: DEFAULT_MIN_FEE_STROOPS,
  },
  futurenet: {
    bufferPct: parseEnvBufferPct("NETWORK_FEE_BUFFER_FUTURENET", 20),
    minFeeStroops: DEFAULT_MIN_FEE_STROOPS,
  },
  default: {
    bufferPct: parseEnvBufferPct("NETWORK_FEE_BUFFER_DEFAULT", DEFAULT_BUFFER_PCT),
    minFeeStroops: DEFAULT_MIN_FEE_STROOPS,
  },
};

/**
 * Resolve the network key from a Stellar network passphrase.
 * Falls back to "default" for any unrecognised passphrase.
 */
export function resolveNetworkKey(passphrase: string): string {
  const lower = passphrase.toLowerCase();
  if (lower.includes("public global stellar")) return "mainnet";
  if (lower.includes("test sdf future")) return "futurenet";
  if (lower.includes("test sdf")) return "testnet";
  return "default";
}

/**
 * Retrieve the fee buffer config for a given network passphrase.
 * Missing network settings fall back to the documented default.
 */
export function getNetworkFeeBuffer(passphrase: string): NetworkFeeBufferConfig {
  const key = resolveNetworkKey(passphrase);
  return NETWORK_FEE_BUFFERS[key] ?? NETWORK_FEE_BUFFERS.default;
}

/**
 * Apply the network fee buffer to a raw fee estimate (in stroops).
 *
 * @param rawFee    - The oracle-reported fee in stroops.
 * @param passphrase - The Stellar network passphrase (used to select buffer).
 * @returns Buffered fee in stroops, clamped to the network minimum.
 */
export function applyFeeBuffer(rawFee: number, passphrase: string): number {
  const config = getNetworkFeeBuffer(passphrase);
  const buffered = rawFee * (1 + config.bufferPct / 100);
  return Math.max(config.minFeeStroops, Math.round(buffered));
}

// ── Oracle constants ─────────────────────────────────────────────────────────

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
    const buffer = getNetworkFeeBuffer(NETWORK_PASSPHRASE);
    const fallbackFees = {
      low: MIN_FEE_STROOPS,
      average: toSafeFee(MIN_FEE_STROOPS * 1.2),
      high: toSafeFee(MIN_FEE_STROOPS * 1.5),
    };
    const fallback: FeeOracleResponse = {
      networkPassphrase: NETWORK_PASSPHRASE,
      sampleSize: 0,
      utilization: {
        averageTxSetSize: 0,
        maxTxSetSize: 0,
        congestionRatio: 0,
      },
      fees: fallbackFees,
      bufferedFees: {
        low: applyFeeBuffer(fallbackFees.low, NETWORK_PASSPHRASE),
        average: applyFeeBuffer(fallbackFees.average, NETWORK_PASSPHRASE),
        high: applyFeeBuffer(fallbackFees.high, NETWORK_PASSPHRASE),
      },
      feeBuffer: buffer,
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

  const computedFees = computePriorityFees(averageBaseFee, congestionRatio);
  const buffer = getNetworkFeeBuffer(NETWORK_PASSPHRASE);

  const result: FeeOracleResponse = {
    networkPassphrase: NETWORK_PASSPHRASE,
    sampleSize: records.length,
    utilization: {
      averageTxSetSize,
      maxTxSetSize,
      congestionRatio,
    },
    fees: computedFees,
    bufferedFees: {
      low: applyFeeBuffer(computedFees.low, NETWORK_PASSPHRASE),
      average: applyFeeBuffer(computedFees.average, NETWORK_PASSPHRASE),
      high: applyFeeBuffer(computedFees.high, NETWORK_PASSPHRASE),
    },
    feeBuffer: buffer,
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
