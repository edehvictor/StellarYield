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

function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as Record<string, unknown>;
  
  // Network errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    return true;
  }
  // HTTP 5xx errors
  if (err.response && typeof err.response === 'object' && err.response !== null) {
    const response = err.response as Record<string, unknown>;
    if (typeof response.status === 'number') {
      return response.status >= 500;
    }
  }
  return false;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number,
  timeoutMs: number
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
        }),
      ]);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000); // cap at 30s
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
  throw lastError;
}

export async function fetchNetworkSnapshot(): Promise<NetworkSnapshot> {
  return retryWithBackoff(
    async () => {
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
    },
    3, // maxRetries
    1000, // baseDelay in ms
    parseInt(process.env.STELLAR_HORIZON_TIMEOUT_MS ?? "10000", 10) // timeout in ms
  );
}
