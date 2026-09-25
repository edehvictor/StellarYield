/**
 * Protocol Adapter Compliance (#417)
 *
 * Reusable utilities for verifying protocol adapters return required fields,
 * handle stale data, normalize errors, and cover partial payloads.
 */

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes default

export interface ProtocolAdapterPayload {
  protocolName: string;
  vaultId: string;
  apy: number;
  tvlUsd: number;
  fetchedAt: string;
  [key: string]: unknown;
}

export interface AdapterValidationResult {
  valid: boolean;
  stale: boolean;
  partial: boolean;
  errors: string[];
}

export interface AdapterComplianceReport {
  adapterName: string;
  success: boolean;
  staleData: boolean;
  partialData: boolean;
  providerFailure: boolean;
  normalizedError?: string;
  payload?: ProtocolAdapterPayload;
  details: string[];
}

/**
 * Check whether a fetchedAt timestamp is stale.
 */
export function checkAdapterStale(
  fetchedAt: string,
  thresholdMs: number = STALE_THRESHOLD_MS,
): boolean {
  const ts = new Date(fetchedAt).getTime();
  if (isNaN(ts)) return true;
  return Date.now() - ts > thresholdMs;
}

/**
 * Validate that a protocol adapter payload contains all required fields
 * and is not stale.
 */
export function validateProtocolAdapterPayload(
  payload: unknown,
): AdapterValidationResult {
  const errors: string[] = [];

  if (payload === null || payload === undefined || typeof payload !== "object") {
    return {
      valid: false,
      stale: false,
      partial: false,
      errors: ["Payload must be a non-null object"],
    };
  }

  const p = payload as Record<string, unknown>;

  if (!p.protocolName || typeof p.protocolName !== "string" || (p.protocolName as string).trim() === "") {
    errors.push("protocolName is required and must be a non-empty string");
  }

  if (!p.vaultId || typeof p.vaultId !== "string" || (p.vaultId as string).trim() === "") {
    errors.push("vaultId is required and must be a non-empty string");
  }

  const hasApy = "apy" in p;
  const hasTvl = "tvlUsd" in p;

  if (!hasApy || !isFinite(p.apy as number)) {
    errors.push("apy is required and must be a finite number");
  }

  if (!hasTvl || !isFinite(p.tvlUsd as number)) {
    errors.push("tvlUsd is required and must be a finite number");
  }

  const partial = (!hasApy || !hasTvl) && (hasApy || hasTvl);
  const stale = checkAdapterStale(p.fetchedAt as string);
  if (stale) {
    errors.push("fetchedAt is stale or invalid");
  }

  return {
    valid: errors.length === 0,
    stale,
    partial,
    errors,
  };
}

/**
 * Normalize any thrown error to a human-readable string.
 */
export function normalizeAdapterError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

/**
 * Run full compliance checks against an adapter factory function.
 */
export async function runProtocolAdapterComplianceChecks(
  adapterName: string,
  adapter: () => Promise<unknown>,
): Promise<AdapterComplianceReport> {
  const details: string[] = [];
  let payload: ProtocolAdapterPayload | undefined;
  let providerFailure = false;
  let normalizedError: string | undefined;

  try {
    const result = await adapter();
    const validation = validateProtocolAdapterPayload(result);

    if (validation.valid) {
      payload = result as ProtocolAdapterPayload;
    }

    details.push(...validation.errors);

    return {
      adapterName,
      success: validation.valid,
      staleData: validation.stale,
      partialData: validation.partial,
      providerFailure: false,
      payload,
      details,
    };
  } catch (err) {
    providerFailure = true;
    normalizedError = normalizeAdapterError(err);
    details.push(`Provider failure: ${normalizedError}`);

    return {
      adapterName,
      success: false,
      staleData: false,
      partialData: false,
      providerFailure,
      normalizedError,
      details,
    };
  }
}
