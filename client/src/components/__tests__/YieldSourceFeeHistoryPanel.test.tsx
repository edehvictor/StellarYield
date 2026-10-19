import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import YieldSourceFeeHistoryPanel from "../YieldSourceFeeHistoryPanel";

describe("YieldSourceFeeHistoryPanel (#1147)", () => {
  it("renders fee history entries newest-first with formatted percentages", () => {
    render(
      <YieldSourceFeeHistoryPanel
        protocolName="Blend"
        feeHistory={[
          { feeBps: 900, changedAt: "2026-01-03T00:00:00.000Z" },
          { feeBps: 1000, changedAt: "2026-01-01T00:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/Blend fee history/i)).toBeInTheDocument();
    const list = screen.getByTestId("fee-history-list");
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    // First rendered item is the newest-first entry as supplied by the caller.
    expect(items[0]).toHaveTextContent("9.00%");
    expect(items[1]).toHaveTextContent("10.00%");
    expect(screen.queryByTestId("fee-history-empty-state")).not.toBeInTheDocument();
  });

  it("renders a clean empty state when history is an empty array", () => {
    render(<YieldSourceFeeHistoryPanel protocolName="Blend" feeHistory={[]} />);

    expect(screen.getByTestId("fee-history-empty-state")).toHaveTextContent(
      /no recent fee changes/i,
    );
    expect(screen.queryByTestId("fee-history-list")).not.toBeInTheDocument();
  });

  it("renders the same empty state (no crash, no layout difference) when history is unavailable (null)", () => {
    render(<YieldSourceFeeHistoryPanel protocolName="Blend" feeHistory={null} />);
    expect(screen.getByTestId("fee-history-empty-state")).toBeInTheDocument();
  });

  it("renders the same empty state when history is unavailable (undefined)", () => {
    render(<YieldSourceFeeHistoryPanel protocolName="Blend" feeHistory={undefined} />);
    expect(screen.getByTestId("fee-history-empty-state")).toBeInTheDocument();
  });

  it("degrades gracefully instead of crashing when feeHistory is a malformed non-array value", () => {
    render(
      <YieldSourceFeeHistoryPanel
        protocolName="Blend"
        feeHistory={"not-an-array" as unknown as null}
      />,
    );
    expect(screen.getByTestId("fee-history-empty-state")).toBeInTheDocument();
  });
});
