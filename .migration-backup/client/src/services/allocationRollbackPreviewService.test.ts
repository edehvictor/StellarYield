/**
 * Tests for the allocation rollback preview client service (#1360).
 * Covers success parsing, typed failure codes, and request wiring.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AllocationRollbackPreviewService,
  AllocationRollbackPreviewServiceError,
} from "./allocationRollbackPreviewService";
import type { AllocationRollbackPreview } from "../../../shared/types/allocationRollback";

global.fetch = vi.fn();

const previewFixture: AllocationRollbackPreview = {
  vaultId: "vault-1",
  source: "pending-rebalance",
  currentAllocations: { Blend: 60, Soroswap: 40 },
  rollbackAllocations: { Blend: 40, Soroswap: 60 },
  changes: [
    { vaultId: "Blend", currentWeight: 60, rollbackWeight: 40, deltaWeight: -20 },
    { vaultId: "Soroswap", currentWeight: 40, rollbackWeight: 60, deltaWeight: 20 },
  ],
  totalDeltaWeight: 0,
  noOp: false,
  conflictingQueueEntryIds: [],
  safe: true,
  inputHash: "a".repeat(64),
};

describe("AllocationRollbackPreviewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches a pending preview and returns the parsed payload", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => previewFixture,
    });

    const result = await AllocationRollbackPreviewService.fetchPendingPreview("vault-1");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/vaults/vault-1/allocation-rollback-preview"),
      expect.anything(),
    );
    expect(result).toEqual(previewFixture);
  });

  it("passes the optional reason query parameter", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => previewFixture,
    });

    await AllocationRollbackPreviewService.fetchPendingPreview("vault-1", "undo drift fix");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("reason=undo%20drift%20fix"),
      expect.anything(),
    );
  });

  it("throws a typed error carrying the server's NO_PENDING_REBALANCE code", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: "NO_PENDING_REBALANCE",
        message: 'No pending rebalance found for vault "vault-1".',
      }),
    });

    let caught: unknown;
    try {
      await AllocationRollbackPreviewService.fetchPendingPreview("vault-1");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AllocationRollbackPreviewServiceError);
    const typed = caught as AllocationRollbackPreviewServiceError;
    expect(typed.code).toBe("NO_PENDING_REBALANCE");
    expect(typed.status).toBe(404);
    expect(typed.message).toContain("No pending rebalance");
  });

  it("falls back to a deterministic message when the error body is not JSON", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
    });

    try {
      await AllocationRollbackPreviewService.fetchPendingPreview("vault-1");
      throw new Error("expected AllocationRollbackPreviewServiceError");
    } catch (err) {
      const typed = err as AllocationRollbackPreviewServiceError;
      expect(typed.code).toBe("ROLLBACK_PREVIEW_FAILED");
      expect(typed.message).toBe(
        "Failed to generate allocation rollback preview: HTTP 503",
      );
    }
  });

  it("POSTs explicit previews with a JSON body", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => previewFixture,
    });

    await AllocationRollbackPreviewService.fetchExplicitPreview("vault-1", {
      currentAllocations: { Blend: 60, Soroswap: 40 },
      rollbackAllocations: { Blend: 40, Soroswap: 60 },
      rollbackReason: "manual",
    });

    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(String(url)).toContain("/api/vaults/vault-1/allocation-rollback-preview");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: expect.stringContaining("rollbackAllocations"),
    });
  });
});
