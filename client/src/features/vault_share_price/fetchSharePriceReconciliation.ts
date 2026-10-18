import { apiUrl } from "../../lib/api";
import type {
  CachedSharePrice,
  SharePriceReconCause,
  SharePriceReconStatus,
  SharePriceSeverity,
  VaultSharePriceErrorCode,
} from "../../../../shared/types/vaultSharePrice";
import type { ReconcileCauseCode } from "../../../../shared/types/reconcileCause";

/**
 * JSON shape of a share-price reconciliation run as served by
 * `GET /api/vaults/:vaultId/share-price/reconcile/history`. The server collapses
 * bigint totals and deltas to decimal strings, so those fields differ from the
 * in-process `SharePriceReconciliationResult`.
 */
export interface SharePriceReconRun {
  id: string;
  status: SharePriceReconStatus;
  vaultId: string;
  contractState: {
    vaultId: string;
    totalAssets: string;
    totalShares: string;
    eventCount: number;
    lastLedger: number;
    lastTxHash: string;
  } | null;
  contractSharePrice: number | null;
  cachedState: CachedSharePrice | null;
  mismatches: Array<{
    field: "sharePrice" | "totalShares" | "totalAssets";
    contractValue: number | string | null;
    cachedValue: number;
    delta: number | string | null;
    deltaPct: number | null;
    severity: SharePriceSeverity;
  }>;
  sharesAgree: boolean;
  assetsAgree: boolean;
  maxDriftPct: number | null;
  isStale: boolean;
  staleDurationMs?: number;
  causes: SharePriceReconCause[];
  primaryCause: ReconcileCauseCode | null;
  timestamp: string;
}

export type SharePriceReconLookup =
  | { kind: "empty" }
  | { kind: "run"; run: SharePriceReconRun };

/** Client-side failure codes, alongside the server's typed codes. */
export type SharePriceReconClientErrorCode =
  | VaultSharePriceErrorCode
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR";

/**
 * Typed failure from the reconciliation history API. `code` comes from the
 * server's `error` field (or a client code when there is no server body), so
 * the UI branches on it instead of parsing messages.
 */
export class SharePriceReconError extends Error {
  readonly code: SharePriceReconClientErrorCode | string;
  readonly status: number;

  constructor(message: string, code: SharePriceReconClientErrorCode | string, status: number) {
    super(message);
    this.name = "SharePriceReconError";
    this.code = code;
    this.status = status;
  }

  /** True when retrying later can plausibly succeed. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

function isRun(value: unknown): value is SharePriceReconRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.vaultId === "string" &&
    (v.status === "success" || v.status === "partial" || v.status === "failed") &&
    Array.isArray(v.causes) &&
    Array.isArray(v.mismatches) &&
    typeof v.timestamp === "string"
  );
}

/** Load the most recent share-price reconciliation run for a vault. */
export async function fetchLatestSharePriceReconciliation(
  vaultId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SharePriceReconLookup> {
  const url = apiUrl(
    `/api/vaults/${encodeURIComponent(vaultId)}/share-price/reconcile/history?limit=1`,
  );

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    throw new SharePriceReconError(
      "Could not reach the reconciliation service.",
      "NETWORK_ERROR",
      0,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const errBody = (body ?? {}) as { error?: unknown; message?: unknown };
    throw new SharePriceReconError(
      typeof errBody.message === "string"
        ? errBody.message
        : `Reconciliation request failed (HTTP ${res.status}).`,
      typeof errBody.error === "string" ? errBody.error : "HTTP_ERROR",
      res.status,
    );
  }

  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new SharePriceReconError(
      "Reconciliation service returned an unexpected response.",
      "INVALID_RESPONSE",
      res.status,
    );
  }
  if (data.length === 0) return { kind: "empty" };
  if (!isRun(data[0])) {
    throw new SharePriceReconError(
      "Reconciliation service returned an unexpected response.",
      "INVALID_RESPONSE",
      res.status,
    );
  }
  return { kind: "run", run: data[0] };
}
