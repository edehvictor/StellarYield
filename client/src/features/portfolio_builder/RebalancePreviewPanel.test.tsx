import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import RebalancePreviewPanel from "./RebalancePreviewPanel";
import type { VaultAllocation } from "./types";

/**
 * Coverage for the stale-snapshot warning state added for issue #1149:
 * the panel must render a visually distinct warning when the preview's
 * market snapshot is fresh, stale, or missing/unknown-age.
 */

const vault = (id: string, name: string, apy: number, weight: number): VaultAllocation => ({
  vaultContractId: id,
  vaultName: name,
  apy,
  weight,
  amount: 0n,
});

const currentAllocations = [vault("c1", "Blend", 8, 50), vault("c2", "Soroswap", 4, 50)];
const targetAllocations = [vault("c1", "Blend", 8, 70), vault("c2", "Soroswap", 4, 30)];

const basePreview = {
  isSimulationOnly: true as const,
  legs: [
    {
      label: "Blend",
      currentWeight: 50,
      targetWeight: 70,
      driftPct: 20,
      currentValueUsd: 5000,
      targetValueUsd: 7000,
      deltaUsd: 2000,
    },
  ],
  blendedApyBefore: 6,
  blendedApyAfter: 6.8,
  apyDeltaPct: 0.8,
  totalTurnoverUsd: 2000,
  estimatedFeeUsd: 4,
  maxDriftPct: 20,
  warnings: [] as string[],
};

function mockFetchOnce(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    }),
  );
}

describe("RebalancePreviewPanel snapshot freshness warning (#1149)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not show a stale warning when the snapshot is fresh", async () => {
    mockFetchOnce({
      ...basePreview,
      snapshotFreshness: { snapshotAgeMs: 60_000, isStale: false, staleSnapshotThresholdMs: 1_800_000 },
    });

    render(
      <RebalancePreviewPanel
        totalValueUsd={10_000}
        currentAllocations={currentAllocations}
        targetAllocations={targetAllocations}
      />,
    );

    fireEvent.click(screen.getByText("Preview rebalance"));

    await waitFor(() => expect(screen.getByText(/Blended APY \(before\)/)).toBeInTheDocument());
    expect(screen.queryByTestId("snapshot-stale-warning")).not.toBeInTheDocument();
  });

  it("shows a distinct stale-snapshot warning when the snapshot is old", async () => {
    mockFetchOnce({
      ...basePreview,
      snapshotFreshness: { snapshotAgeMs: 3_600_000, isStale: true, staleSnapshotThresholdMs: 1_800_000 },
    });

    render(
      <RebalancePreviewPanel
        totalValueUsd={10_000}
        currentAllocations={currentAllocations}
        targetAllocations={targetAllocations}
      />,
    );

    fireEvent.click(screen.getByText("Preview rebalance"));

    const warning = await screen.findByTestId("snapshot-stale-warning");
    expect(warning).toHaveTextContent(/1 hour old/);
  });

  it("shows the stale warning with an unknown-age message when the timestamp is missing", async () => {
    mockFetchOnce({
      ...basePreview,
      snapshotFreshness: { snapshotAgeMs: null, isStale: true, staleSnapshotThresholdMs: 1_800_000 },
    });

    render(
      <RebalancePreviewPanel
        totalValueUsd={10_000}
        currentAllocations={currentAllocations}
        targetAllocations={targetAllocations}
      />,
    );

    fireEvent.click(screen.getByText("Preview rebalance"));

    const warning = await screen.findByTestId("snapshot-stale-warning");
    expect(warning).toHaveTextContent(/could not be confirmed/);
  });
});
