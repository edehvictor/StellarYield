/**
 * Client service for deterministic vault allocation rollback previews (#1360).
 *
 * Thin typed wrapper over the read-only preview endpoints. Failures are
 * surfaced as `AllocationRollbackPreviewServiceError` carrying the server's
 * stable error code so the UI can branch (empty vs. failure) without parsing
 * raw provider output.
 */

import { apiUrl, apiFetch } from "../lib/api";
import type { AllocationRollbackPreview } from "../../../shared/types/allocationRollback";

export interface AllocationRollbackPreviewRequestBody {
  currentAllocations?: Record<string, number>;
  rollbackAllocations: Record<string, number>;
  rollbackReason?: string;
}

/** Typed client error carrying the server's machine-readable code. */
export class AllocationRollbackPreviewServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AllocationRollbackPreviewServiceError";
  }
}

async function readPreviewResponse(response: Response): Promise<AllocationRollbackPreview> {
  if (response.ok) {
    return (await response.json()) as AllocationRollbackPreview;
  }

  let code = "ROLLBACK_PREVIEW_FAILED";
  let message = `Failed to generate allocation rollback preview: HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      code = body.error;
    }
    if (typeof body.message === "string" && body.message.length > 0) {
      message = body.message;
    }
  } catch {
    // Non-JSON error body — keep the deterministic fallback message.
  }

  throw new AllocationRollbackPreviewServiceError(code, message, response.status);
}

export class AllocationRollbackPreviewService {
  /**
   * Preview a rollback derived from the vault's latest pending rebalance.
   * Throws code `NO_PENDING_REBALANCE` (404) when there is nothing to roll.
   */
  static async fetchPendingPreview(
    vaultId: string,
    reason?: string,
  ): Promise<AllocationRollbackPreview> {
    const params = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    const response = await apiFetch(
      apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/allocation-rollback-preview${params}`),
    );
    return readPreviewResponse(response);
  }

  /**
   * Preview an ad-hoc rollback from explicit allocation maps. When
   * `currentAllocations` is omitted the server falls back to the vault's
   * pending queue entry.
   */
  static async fetchExplicitPreview(
    vaultId: string,
    body: AllocationRollbackPreviewRequestBody,
  ): Promise<AllocationRollbackPreview> {
    const response = await apiFetch(
      apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/allocation-rollback-preview`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return readPreviewResponse(response);
  }
}
