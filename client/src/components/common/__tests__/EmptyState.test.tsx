import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EmptyState from "../EmptyState";
import { EmptyStateFromCopy } from "../EmptyState";
import {
  EMPTY_STATE_APY,
  EMPTY_STATE_STRATEGY_HEALTH,
} from "../../../utils/emptyStateCopy";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(
      <EmptyState title="No data yet" description="Data will appear soon." />,
    );
    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.getByText("Data will appear soon.")).toBeInTheDocument();
  });

  it("renders with optional icon", () => {
    render(
      <EmptyState
        icon={<span data-testid="icon">🔍</span>}
        title="Nothing here"
      />,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("renders optional action button", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Empty"
        action={{ label: "Refresh", onClick }}
      />,
    );
    const btn = screen.getByRole("button", { name: "Refresh" });
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("sets data-testid when provided", () => {
    render(
      <EmptyState title="Test" testId="my-empty-state" />,
    );
    expect(screen.getByTestId("my-empty-state")).toBeInTheDocument();
  });

  it("does not render description when omitted", () => {
    render(<EmptyState title="Only title" />);
    expect(screen.getByText("Only title")).toBeInTheDocument();
    expect(screen.queryByText(/will appear/)).not.toBeInTheDocument();
  });
});

describe("EmptyStateFromCopy", () => {
  it("renders title and description from copy constant", () => {
    render(<EmptyStateFromCopy copy={EMPTY_STATE_APY} />);
    expect(screen.getByText(EMPTY_STATE_APY.title)).toBeInTheDocument();
    expect(
      screen.getByText(EMPTY_STATE_APY.description),
    ).toBeInTheDocument();
  });

  it("passes icon through", () => {
    render(
      <EmptyStateFromCopy
        copy={EMPTY_STATE_STRATEGY_HEALTH}
        icon={<span data-testid="icon">📊</span>}
      />,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("passes action through", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <EmptyStateFromCopy
        copy={EMPTY_STATE_APY}
        action={{ label: "Retry", onClick }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("passes testId through", () => {
    render(
      <EmptyStateFromCopy
        copy={EMPTY_STATE_STRATEGY_HEALTH}
        testId="my-test"
      />,
    );
    expect(screen.getByTestId("my-test")).toBeInTheDocument();
  });
});
