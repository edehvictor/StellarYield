/**
 * Failure-injection tests for client API service surfaces.
 *
 * Verifies that RebalanceFeedService and WatchlistClientService surface errors
 * correctly to callers when the backend is unavailable, returns 503, or drops
 * the connection.
 *
 * Uses vi.stubGlobal('fetch', ...) with afterEach cleanup to prevent test pollution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RebalanceFeedService } from "./rebalanceFeedService";
import { WatchlistClientService } from "./watchlistClientService";

// Stub crypto.randomUUID (not available in jsdom non-secure context)
beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "failtest-uuid-0000" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── RebalanceFeedService ──────────────────────────────────────────────────────

describe("Failure injection: RebalanceFeedService", () => {
  it("fetchRebalanceEvents throws when fetch rejects (network outage)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    await expect(RebalanceFeedService.fetchRebalanceEvents()).rejects.toThrow("Network error");
  });

  it("fetchRebalanceEvents throws when server returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(RebalanceFeedService.fetchRebalanceEvents()).rejects.toThrow(
      "Failed to fetch rebalance events",
    );
  });

  it("fetchRebalanceEvents throws when server returns 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(RebalanceFeedService.fetchRebalanceEvents()).rejects.toThrow(
      "Failed to fetch rebalance events",
    );
  });

  it("fetchRecentRebalances throws on network outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(
      RebalanceFeedService.fetchRecentRebalances("vault-1"),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("fetchRecentRebalances throws when server returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(
      RebalanceFeedService.fetchRecentRebalances("vault-1"),
    ).rejects.toThrow("Failed to fetch recent rebalances");
  });

  it("startPolling calls onUpdate with error flag on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const onUpdate = vi.fn();
    const unsubscribe = RebalanceFeedService.startPolling("vault-1", onUpdate, 10000);

    // poll() is async — flush microtask queue so the catch block fires
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUpdate).toHaveBeenCalledWith([], true);

    unsubscribe();
  });
});

// ── WatchlistClientService ────────────────────────────────────────────────────

describe("Failure injection: WatchlistClientService", () => {
  const WALLET = "GWALLETTEST00000000000000000000000000000000000000000001";

  it("getWatchlist throws when server returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(WatchlistClientService.getWatchlist(WALLET)).rejects.toThrow(
      "Failed to fetch watchlist",
    );
  });

  it("getWatchlist throws on network outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(WatchlistClientService.getWatchlist(WALLET)).rejects.toThrow("ECONNREFUSED");
  });

  it("addToWatchlist throws when server returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(
      WatchlistClientService.addToWatchlist(WALLET, "opp-1", "protocol", "Blend", 8.5, 100000),
    ).rejects.toThrow("Failed to add to watchlist");
  });

  it("addToWatchlist throws on network outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    await expect(
      WatchlistClientService.addToWatchlist(WALLET, "opp-1", "protocol", "Blend", 8.5, 100000),
    ).rejects.toThrow("Network error");
  });

  it("removeFromWatchlist throws when server returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(
      WatchlistClientService.removeFromWatchlist(WALLET, "item-1"),
    ).rejects.toThrow("Failed to remove from watchlist");
  });
});
