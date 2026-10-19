import { describe, expect, it, vi } from "vitest";
import {
  fetchLatestSharePriceReconciliation,
  SharePriceReconError,
} from "./fetchSharePriceReconciliation";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const RUN = {
  id: "sp_recon_1",
  status: "success",
  vaultId: "CVAULT",
  contractState: null,
  contractSharePrice: 1,
  cachedState: null,
  mismatches: [],
  sharesAgree: true,
  assetsAgree: true,
  maxDriftPct: null,
  isStale: false,
  causes: [],
  primaryCause: null,
  timestamp: "2026-09-24T00:00:00.000Z",
};

describe("fetchLatestSharePriceReconciliation", () => {
  it("requests the newest run for the encoded vault id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [RUN] }));
    const result = await fetchLatestSharePriceReconciliation("CV/1", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "/api/vaults/CV%2F1/share-price/reconcile/history?limit=1",
    );
    expect(result).toEqual({ kind: "run", run: RUN });
  });

  it("returns empty when no runs exist", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));
    await expect(fetchLatestSharePriceReconciliation("CVAULT", fetchImpl)).resolves.toEqual({
      kind: "empty",
    });
  });

  it("surfaces the server error code, not the message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: "CACHE_UNAVAILABLE", message: "anything" }));
    const err = await fetchLatestSharePriceReconciliation("CVAULT", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(SharePriceReconError);
    expect(err.code).toBe("CACHE_UNAVAILABLE");
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it("maps a non-JSON error body to HTTP_ERROR", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>", { status: 400 }));
    const err = await fetchLatestSharePriceReconciliation("CVAULT", fetchImpl).catch((e) => e);
    expect(err.code).toBe("HTTP_ERROR");
    expect(err.retryable).toBe(false);
  });

  it("maps a fetch rejection to NETWORK_ERROR", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await fetchLatestSharePriceReconciliation("CVAULT", fetchImpl).catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.status).toBe(0);
  });

  it("rejects a malformed payload as INVALID_RESPONSE", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ nope: true }] }));
    const err = await fetchLatestSharePriceReconciliation("CVAULT", fetchImpl).catch((e) => e);
    expect(err.code).toBe("INVALID_RESPONSE");
  });
});
