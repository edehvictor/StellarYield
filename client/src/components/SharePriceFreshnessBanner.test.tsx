import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SharePriceFreshnessBanner from "./SharePriceFreshnessBanner";
import type { SharePriceFreshness } from "../lib/sharePriceFreshness";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeFreshness(
  overrides: Partial<SharePriceFreshness> = {},
): SharePriceFreshness {
  return {
    vaultId: "primary-yield-vault",
    status: "current",
    isDelayed: false,
    sharePriceUpdatedAt: "2026-09-25T10:00:00.000Z",
    eventCheckpointAt: "2026-09-25T11:00:00.000Z",
    delayMs: 3_600_000,
    maxDelayMs: 129_600_000,
    message: null,
    evaluatedAt: "2026-09-25T12:00:00.000Z",
    ...overrides,
  };
}

function okResponse(payload: unknown) {
  return { ok: true, json: async () => payload } as Response;
}

describe("SharePriceFreshnessBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests freshness for the vault", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(makeFreshness()));

    render(<SharePriceFreshnessBanner vaultId="primary-yield-vault" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/api/vaults/primary-yield-vault/share-price-freshness",
    );
  });

  it("renders nothing when data is current", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(makeFreshness()));

    render(<SharePriceFreshnessBanner vaultId="primary-yield-vault" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("share-price-freshness-banner")).toBeNull(),
    );
  });

  it("shows a delayed warning including the last known update", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(
        makeFreshness({
          status: "delayed",
          isDelayed: true,
          sharePriceUpdatedAt: "2026-09-23T11:04:05.000Z",
          message:
            "Share price data is 49.0h behind the latest indexed event (last known update: 2026-09-23T11:04:05.000Z).",
        }),
      ),
    );

    render(<SharePriceFreshnessBanner vaultId="primary-yield-vault" />);

    expect(
      await screen.findByTestId("share-price-freshness-banner"),
    ).toBeInTheDocument();
    expect(screen.getByText("Share price delayed")).toBeInTheDocument();
    expect(screen.getByText(/behind the latest indexed event/)).toBeInTheDocument();
    expect(screen.getByText(/Last known update: 2026-09-23 11:04:05 UTC/)).toBeInTheDocument();
  });

  it("shows a danger warning when share price data is missing", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(
        makeFreshness({
          status: "missing",
          isDelayed: true,
          sharePriceUpdatedAt: null,
          message: "No share price snapshot recorded.",
        }),
      ),
    );

    render(<SharePriceFreshnessBanner vaultId="primary-yield-vault" />);

    expect(
      await screen.findByTestId("share-price-freshness-banner"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Share price data unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Last known update/)).toBeNull();
  });

  it("stays quiet when the request fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("offline"));

    render(<SharePriceFreshnessBanner vaultId="primary-yield-vault" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("share-price-freshness-banner")).toBeNull(),
    );
  });

  it("stays quiet on a non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    render(<SharePriceFreshnessBanner vaultId="primary-yield-vault" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("share-price-freshness-banner")).toBeNull(),
    );
  });
});
