import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VaultSharePriceReconcilePanel from "./VaultSharePriceReconcilePanel";
import {
  SharePriceReconError,
  type SharePriceReconRun,
} from "./fetchSharePriceReconciliation";

function run(overrides: Partial<SharePriceReconRun> = {}): SharePriceReconRun {
  return {
    id: "sp_recon_1",
    status: "success",
    vaultId: "CVAULT",
    contractState: {
      vaultId: "CVAULT",
      totalAssets: "1100000",
      totalShares: "1000000",
      eventCount: 4,
      lastLedger: 812,
      lastTxHash: "abc",
    },
    contractSharePrice: 1.1,
    cachedState: {
      vaultId: "CVAULT",
      sharePrice: 1.1,
      totalShares: 1_000_000,
      totalAssets: 1_100_000,
      snapshotAt: "2026-09-24T00:00:00.000Z",
    },
    mismatches: [],
    sharesAgree: true,
    assetsAgree: true,
    maxDriftPct: null,
    isStale: false,
    causes: [],
    primaryCause: null,
    timestamp: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("VaultSharePriceReconcilePanel", () => {
  it("shows a loading state, then the in-sync result", async () => {
    const fetchLatest = vi.fn().mockResolvedValue({ kind: "run", run: run() });
    render(<VaultSharePriceReconcilePanel vaultId="CVAULT" fetchLatest={fetchLatest} />);

    expect(screen.getByTestId("share-price-recon-loading")).toBeInTheDocument();
    const panel = await screen.findByTestId("share-price-recon-result");
    expect(panel).toHaveAttribute("data-status", "success");
    expect(screen.getByText("In sync")).toBeInTheDocument();
    expect(screen.getByTestId("contract-share-price")).toHaveTextContent("1.100000");
    expect(screen.getByTestId("cached-share-price")).toHaveTextContent("1.100000");
    expect(fetchLatest).toHaveBeenCalledWith("CVAULT");
  });

  it("lists drift causes when the cache disagrees with contract events", async () => {
    const fetchLatest = vi.fn().mockResolvedValue({
      kind: "run",
      run: run({
        status: "partial",
        contractSharePrice: 1.2,
        maxDriftPct: 0.0909,
        primaryCause: "AMOUNT_DRIFT",
        causes: [
          {
            code: "AMOUNT_DRIFT",
            category: "amount",
            severity: "warning",
            title: "Amount drift",
            summary: "",
            remediation: "Re-sync the projection",
            detail: "share price drift: contract-derived 1.2 vs cache 1.1",
          } as SharePriceReconRun["causes"][number],
        ],
      }),
    });
    render(<VaultSharePriceReconcilePanel vaultId="CVAULT" fetchLatest={fetchLatest} />);

    await screen.findByText("Drift detected");
    expect(screen.getByTestId("max-drift")).toHaveTextContent("9.09%");
    const causes = screen.getByTestId("share-price-recon-causes");
    expect(causes.querySelector('[data-cause="AMOUNT_DRIFT"]')).not.toBeNull();
    expect(causes).toHaveTextContent("contract-derived 1.2 vs cache 1.1");
  });

  it("renders the empty state when no run exists", async () => {
    const fetchLatest = vi.fn().mockResolvedValue({ kind: "empty" });
    render(<VaultSharePriceReconcilePanel vaultId="CVAULT" fetchLatest={fetchLatest} />);
    expect(await screen.findByTestId("share-price-recon-empty")).toBeInTheDocument();
  });

  it("renders the unconfigured state without fetching when no vault id exists", () => {
    const fetchLatest = vi.fn();
    render(<VaultSharePriceReconcilePanel vaultId="" fetchLatest={fetchLatest} />);
    expect(screen.getByTestId("share-price-recon-unconfigured")).toBeInTheDocument();
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("shows a typed error and retries a retryable failure", async () => {
    const fetchLatest = vi
      .fn()
      .mockRejectedValueOnce(new SharePriceReconError("x", "CACHE_UNAVAILABLE", 503))
      .mockResolvedValueOnce({ kind: "run", run: run() });
    render(<VaultSharePriceReconcilePanel vaultId="CVAULT" fetchLatest={fetchLatest} />);

    const errorPanel = await screen.findByTestId("share-price-recon-error");
    expect(errorPanel).toHaveAttribute("data-error-code", "CACHE_UNAVAILABLE");
    expect(errorPanel).toHaveTextContent("share-price cache is unreachable");

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByTestId("share-price-recon-result")).toBeInTheDocument());
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("does not offer retry for a non-retryable client error", async () => {
    const fetchLatest = vi
      .fn()
      .mockRejectedValue(new SharePriceReconError("bad", "MALFORMED_INPUT", 400));
    render(<VaultSharePriceReconcilePanel vaultId="CVAULT" fetchLatest={fetchLatest} />);
    await screen.findByTestId("share-price-recon-error");
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
