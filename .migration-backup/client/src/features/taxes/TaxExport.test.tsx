import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import TaxExport from "./TaxExport";

vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: true,
    walletAddress: "GDETESTWALLET123",
  }),
}));

vi.mock("../../lib/api", () => ({
  getApiBaseUrl: () => "http://test",
}));

const cleanPreview = {
  rows: [
    {
      date: "2026-01-01T00:00:00.000Z",
      action: "DEPOSIT",
      asset: "USDC",
      amount: 100,
      costBasisUsd: 100,
      realizedYieldUsd: null,
      txHash: "tx-1",
      warnings: [],
    },
  ],
  warnings: [],
  totals: { costBasisUsd: 100, realizedYieldUsd: 0, rows: 1 },
  canDownload: true,
};

const warningPreview = {
  rows: [
    {
      date: null,
      action: "DEPOSIT",
      asset: "AQUA",
      amount: 5,
      costBasisUsd: null,
      realizedYieldUsd: null,
      txHash: "tx-broken",
      warnings: ["MISSING_TIMESTAMP", "UNSUPPORTED_TOKEN"],
    },
  ],
  warnings: [
    {
      code: "MISSING_TIMESTAMP",
      message: "Row 1 (tx tx-broken) is missing a usable timestamp.",
      rowIndex: 0,
    },
    {
      code: "UNSUPPORTED_TOKEN",
      message: 'Row 1 uses unsupported asset "AQUA".',
      rowIndex: 0,
    },
  ],
  totals: { costBasisUsd: 0, realizedYieldUsd: 0, rows: 1 },
  canDownload: false,
};

const respondWith = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

describe("TaxExport", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires a preview before the download button activates", () => {
    render(<TaxExport />);
    const download = screen.getByRole("button", {
      name: /preview required before download/i,
    });
    expect(download).toBeDisabled();
  });

  it("renders the preview table and enables download when canDownload is true", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      respondWith(cleanPreview),
    );

    render(<TaxExport />);
    fireEvent.click(screen.getByRole("button", { name: /preview tax lots/i }));

    await waitFor(() => {
      expect(screen.getByTestId("tax-preview")).toBeInTheDocument();
    });
    expect(screen.getByText(/Rows: 1/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download tax report/i }),
    ).not.toBeDisabled();
  });

  it("surfaces warnings and keeps download disabled when canDownload is false", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      respondWith(warningPreview),
    );

    render(<TaxExport />);
    fireEvent.click(screen.getByRole("button", { name: /preview tax lots/i }));

    await waitFor(() => {
      expect(screen.getByTestId("tax-preview")).toBeInTheDocument();
    });
    expect(screen.getByText(/2 warning\(s\) found/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /resolve warnings to download/i }),
    ).toBeDisabled();
  });

  it("shows a user-friendly message when the preview returns 404", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("", { status: 404 }),
    );

    render(<TaxExport />);
    fireEvent.click(screen.getByRole("button", { name: /preview tax lots/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /No transactions found/i,
      );
    });
  });
});
