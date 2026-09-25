import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import AuditReplayReportPanel from "./AuditReplayReportPanel";

describe("AuditReplayReportPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders summary counts when API succeeds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: {
              total: 2,
              deterministicCount: 1,
              discrepancyCount: 1,
              mismatchRate: 0.5,
            },
            items: [
              {
                recordId: "rec-1",
                strategyId: "default-strategy",
                executedAt: "2026-01-01T00:00:00.000Z",
                recommendedAction: "hold",
                replayedAction: "sell",
                isDeterministic: false,
                discrepancies: [
                  {
                    code: "ACTION_MISMATCH",
                    field: "recommendedAction",
                    original: "hold",
                    replayed: "sell",
                    message: "Recommended action differs.",
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    render(<AuditReplayReportPanel />);

    await waitFor(() => {
      expect(screen.getByText("Audit Replay Report")).toBeInTheDocument();
      expect(screen.getByText("Total")).toBeInTheDocument();
      expect(screen.getByText("Deterministic")).toBeInTheDocument();
      expect(screen.getByText("Discrepancies")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getAllByText("1")).toHaveLength(2);
      expect(screen.getByText("50.00%")).toBeInTheDocument();
    });
  });

  it("renders error on failed API response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "Boom" }), { status: 500 }),
    );

    render(<AuditReplayReportPanel />);

    await waitFor(() => {
      expect(screen.getByText("Boom")).toBeInTheDocument();
    });
  });
});
