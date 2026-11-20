import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DailyMovementPanel } from "./DailyMovementPanel";
import type { DailyMovement } from "../../../shared/types/dailyMovement";

const HOUR_MS = 60 * 60 * 1000;

const baseMovement = (
  overrides: Partial<DailyMovement> = {},
): DailyMovement => ({
  walletAddress: `G${"A".repeat(55)}`,
  snapshotDate: "2026-09-24",
  previousSnapshotDate: "2026-09-23",
  previousTotalValue: 1000,
  currentTotalValue: 1100,
  totalAbsoluteChange: 100,
  totalPercentChange: 10,
  assetMovements: [],
  protocolMovements: [],
  depositedToday: 0,
  withdrawnToday: 0,
  priceMovementOnly: 100,
  hasPreviousSnapshot: true,
  isNegativeMovement: false,
  ...overrides,
});

describe("DailyMovementPanel freshness notice (#1362)", () => {
  it("does not render a notice when the snapshot is fresh", () => {
    render(
      <DailyMovementPanel
        movement={baseMovement({
          freshness: {
            evaluatedAt: new Date().toISOString(),
            snapshotValuedAt: new Date(Date.now() - HOUR_MS).toISOString(),
            ageMs: HOUR_MS,
            maxAgeMs: 36 * HOUR_MS,
            isStale: false,
          },
        })}
      />,
    );

    expect(screen.getByText("Daily Portfolio Movement")).toBeDefined();
    expect(
      screen.queryByTestId("daily-movement-freshness-notice"),
    ).toBeNull();
  });

  it("renders the stale notice when the annotation reports staleness", () => {
    render(
      <DailyMovementPanel
        movement={baseMovement({
          freshness: {
            evaluatedAt: new Date().toISOString(),
            snapshotValuedAt: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
            ageMs: 48 * HOUR_MS,
            maxAgeMs: 36 * HOUR_MS,
            isStale: true,
          },
        })}
      />,
    );

    const notice = screen.getByTestId("daily-movement-freshness-notice");
    expect(notice.textContent).toContain("may be stale");
    expect(notice.textContent).toContain("48h ago");
  });

  it("renders the missing-snapshot notice in the neutral state", () => {
    render(
      <DailyMovementPanel
        movement={baseMovement({
          hasPreviousSnapshot: false,
          freshness: {
            evaluatedAt: new Date().toISOString(),
            snapshotValuedAt: null,
            ageMs: null,
            maxAgeMs: 36 * HOUR_MS,
            isStale: true,
          },
        })}
      />,
    );

    expect(
      screen.getByText("No previous snapshot available for comparison."),
    ).toBeDefined();
    const notice = screen.getByTestId("daily-movement-freshness-notice");
    expect(notice.textContent).toContain("No valuation snapshot available");
  });

  it("tolerates payloads without a freshness annotation", () => {
    render(<DailyMovementPanel movement={baseMovement()} />);
    expect(
      screen.queryByTestId("daily-movement-freshness-notice"),
    ).toBeNull();
  });

  it("shows the notice in compact mode too", () => {
    render(
      <DailyMovementPanel
        compact
        movement={baseMovement({
          freshness: {
            evaluatedAt: new Date().toISOString(),
            snapshotValuedAt: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
            ageMs: 48 * HOUR_MS,
            maxAgeMs: 36 * HOUR_MS,
            isStale: true,
          },
        })}
      />,
    );
    expect(screen.getByTestId("daily-movement-freshness-notice")).toBeDefined();
  });
});
