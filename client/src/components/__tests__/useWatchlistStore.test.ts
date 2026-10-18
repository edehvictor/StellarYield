import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useWatchlistStore } from "../useWatchlistStore";
import { WatchlistClientService } from "../../services/watchlistClientService";
import type { WatchlistItem, WatchlistResponse } from "../../../../shared/types/watchlist";

vi.mock("../../services/watchlistClientService", () => ({
  WatchlistClientService: {
    getWatchlist: vi.fn(),
    removeFromWatchlist: vi.fn(),
    addThresholdRule: vi.fn(),
  },
}));

const mockGetWatchlist = vi.mocked(WatchlistClientService.getWatchlist);

const WALLET_A = "GWALLETA0000000000000000000000000000000000000000000001";
const WALLET_B = "GWALLETB0000000000000000000000000000000000000000000002";

function makeItem(id: string, name: string): WatchlistItem {
  return {
    id,
    userId: "unused",
    opportunityId: `opp-${id}`,
    opportunityType: "protocol",
    opportunityName: name,
    currentApy: 5,
    currentTvl: 1_000_000,
    ruleCount: 0,
    alertCount: 0,
  };
}

function makeResponse(items: WatchlistItem[]): WatchlistResponse {
  return { items, total: items.length, totalUnacknowledgedAlerts: 0 };
}

beforeEach(() => {
  localStorage.clear();
  mockGetWatchlist.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe("useWatchlistStore — wallet switch (#1173)", () => {
  it("clears state when the wallet disconnects (null)", async () => {
    mockGetWatchlist.mockResolvedValue(makeResponse([makeItem("1", "Blend")]));

    const { result, rerender } = renderHook(
      ({ wallet }: { wallet: string | null }) => useWatchlistStore(wallet),
      { initialProps: { wallet: WALLET_A } }
    );

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    rerender({ wallet: null });

    expect(result.current.items).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  it("does not leak wallet A's items into wallet B's view during an in-flight switch", async () => {
    let resolveA: (r: WatchlistResponse) => void = () => {};
    const pendingA = new Promise<WatchlistResponse>((resolve) => {
      resolveA = resolve;
    });
    mockGetWatchlist.mockImplementation((address: string) => {
      if (address === WALLET_A) return pendingA;
      return Promise.resolve(makeResponse([makeItem("b1", "Soroswap")]));
    });

    const { result, rerender } = renderHook(
      ({ wallet }: { wallet: string | null }) => useWatchlistStore(wallet),
      { initialProps: { wallet: WALLET_A } }
    );

    // Switch to wallet B before wallet A's fetch resolves.
    rerender({ wallet: WALLET_B });

    // No stale/leaked items from A should be visible during the switch.
    expect(result.current.items.every((i) => i.opportunityName !== "Blend")).toBe(true);

    await waitFor(() =>
      expect(result.current.items.some((i) => i.opportunityName === "Soroswap")).toBe(true)
    );

    // Now let wallet A's slow response resolve — it must be discarded, not overwrite B's state.
    await act(async () => {
      resolveA(makeResponse([makeItem("a1", "Blend")]));
      await pendingA;
    });

    expect(result.current.items.some((i) => i.opportunityName === "Blend")).toBe(false);
    expect(result.current.items.some((i) => i.opportunityName === "Soroswap")).toBe(true);
  });

  it("restores the wallet's own local snapshot on reconnect", async () => {
    mockGetWatchlist.mockResolvedValue(makeResponse([makeItem("1", "Blend")]));

    const first = renderHook(
      ({ wallet }: { wallet: string | null }) => useWatchlistStore(wallet),
      { initialProps: { wallet: WALLET_A } }
    );
    await waitFor(() => expect(first.result.current.items).toHaveLength(1));
    first.unmount();

    // Simulate disconnect, then a fresh mount reconnecting the same wallet —
    // the local snapshot should render instantly, before the network call resolves.
    mockGetWatchlist.mockImplementation(() => new Promise(() => {}));
    const second = renderHook(
      ({ wallet }: { wallet: string | null }) => useWatchlistStore(wallet),
      { initialProps: { wallet: WALLET_A } }
    );

    expect(second.result.current.items).toHaveLength(1);
    expect(second.result.current.items[0].opportunityName).toBe("Blend");
  });
});
