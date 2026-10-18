import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  TransactionErrorBoundary,
  createTransactionErrorId,
} from "./TransactionErrorBoundary";

// ─── Helpers ────────────────────────────────────────────────────────────────

function Boom({ message = "kaboom from deposit" }: { message?: string }) {
  throw new Error(message);
}

// ─── createTransactionErrorId ────────────────────────────────────────────────

describe("createTransactionErrorId", () => {
  it("produces a stable, prefixed identifier", () => {
    const id = createTransactionErrorId();
    expect(id).toMatch(/^tx-[a-z0-9]+$/i);
    expect(createTransactionErrorId()).not.toBe(id);
  });
});

// ─── TransactionErrorBoundary ────────────────────────────────────────────────

describe("TransactionErrorBoundary", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when there is no error", () => {
    render(
      <TransactionErrorBoundary workflowName="deposit">
        <div>deposit form</div>
      </TransactionErrorBoundary>,
    );
    expect(screen.queryByText("deposit form")).not.toBeNull();
    expect(screen.queryByTestId("transaction-error-boundary")).toBeNull();
  });

  it("shows a contained fallback that names the workflow and preserves the real message", () => {
    render(
      <TransactionErrorBoundary workflowName="deposit">
        <Boom />
      </TransactionErrorBoundary>,
    );

    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryByText(/deposit step could not be displayed/i)).not.toBeNull();
    expect(screen.queryByText(/kaboom from deposit/)).not.toBeNull();
    // The real error was logged, not silently discarded.
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("reports the workflow name and error id through structured diagnostics", () => {
    render(
      <TransactionErrorBoundary workflowName="withdraw">
        <Boom message="withdraw render failed" />
      </TransactionErrorBoundary>,
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "[diagnostics] transaction workflow failure",
      expect.objectContaining({
        workflowName: "withdraw",
        errorId: expect.stringMatching(/^tx-/),
        message: "withdraw render failed",
      }),
    );
  });

  it("renders the correlation id so a support ticket can be matched to the failure", () => {
    render(
      <TransactionErrorBoundary workflowName="governance-execute">
        <Boom />
      </TransactionErrorBoundary>,
    );

    expect(screen.queryByText(/reference:/)).not.toBeNull();
  });

  it("invokes onError with the thrown error and the correlation id", () => {
    const onError = vi.fn();
    render(
      <TransactionErrorBoundary workflowName="deposit" onError={onError}>
        <Boom message="callback failure" />
      </TransactionErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, errorId] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("callback failure");
    expect(errorId).toMatch(/^tx-/);
  });

  it("recovers in place when the user retries", () => {
    let shouldThrow = true;
    function MaybeBoom() {
      if (shouldThrow) throw new Error("kaboom from deposit");
      return <div>recovered deposit form</div>;
    }

    render(
      <TransactionErrorBoundary workflowName="deposit">
        <MaybeBoom />
      </TransactionErrorBoundary>,
    );

    const retry = screen.getByRole("button", { name: /try again/i });
    shouldThrow = false;
    fireEvent.click(retry);

    expect(screen.queryByText("recovered deposit form")).not.toBeNull();
    expect(screen.queryByTestId("transaction-error-boundary")).toBeNull();
  });

  it("copies a redacted payload and confirms the action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <TransactionErrorBoundary workflowName="withdraw">
        <Boom message="copy me" />
      </TransactionErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy details/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const payload = writeText.mock.calls[0][0] as string;
    expect(payload).toContain('title=Transaction workflow "withdraw" failed to render');
    expect(payload).toContain("message=copy me");

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /copied/i })).not.toBeNull(),
    );
  });

  it("stays resilient when the clipboard API is unavailable", () => {
    Object.assign(navigator, { clipboard: undefined });

    render(
      <TransactionErrorBoundary workflowName="deposit">
        <Boom />
      </TransactionErrorBoundary>,
    );

    // Should not throw while falling back to execCommand.
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /copy details/i })),
    ).not.toThrow();
  });
});
