/**
 * GovernanceVoteStatus: concurrent refreshes and changing receipts (#1895).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  GovernanceVoteStatus,
  isStaleReceipt,
  type VoteReceipt,
} from "../GovernanceVoteStatus";

const receipt = (over: Partial<VoteReceipt> = {}): VoteReceipt => ({
  receiptId: "r-1",
  proposalId: "p-1",
  voter: "GVOTER",
  choice: "yes",
  submittedAt: "2026-01-01T00:00:00.000Z",
  status: "pending",
  reconciliationAttempts: 0,
  ...over,
});

interface Deferred {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (r: VoteReceipt) => void;
  fail: (status: number) => void;
  reject: () => void;
}

/** A fetch whose replies the test releases by hand, in any order. */
function controlledFetch() {
  const calls: Deferred[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      calls.push({
        url,
        signal: init?.signal ?? undefined,
        resolve: (r) => resolve(new Response(JSON.stringify(r), { status: 200 })),
        fail: (status) => resolve(new Response("{}", { status })),
        reject: () => reject(new Error("network")),
      });
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("isStaleReceipt", () => {
  it("treats an earlier lifecycle stage as stale", () => {
    expect(isStaleReceipt(receipt({ status: "recorded" }), receipt({ status: "pending" }))).toBe(true);
    expect(isStaleReceipt(receipt({ status: "delayed" }), receipt({ status: "pending" }))).toBe(true);
    expect(isStaleReceipt(receipt({ status: "pending" }), receipt({ status: "delayed" }))).toBe(false);
  });

  it("never replaces a final status with a different one", () => {
    expect(isStaleReceipt(receipt({ status: "recorded" }), receipt({ status: "failed" }))).toBe(true);
    expect(isStaleReceipt(receipt({ status: "failed" }), receipt({ status: "recorded" }))).toBe(true);
    expect(isStaleReceipt(receipt({ status: "recorded" }), receipt({ status: "recorded" }))).toBe(false);
  });

  it("drops a reply with fewer reconciliation attempts at the same stage", () => {
    expect(
      isStaleReceipt(receipt({ reconciliationAttempts: 3 }), receipt({ reconciliationAttempts: 2 })),
    ).toBe(true);
    expect(
      isStaleReceipt(receipt({ reconciliationAttempts: 2 }), receipt({ reconciliationAttempts: 3 })),
    ).toBe(false);
  });

  it("never calls the first or a different receipt stale", () => {
    expect(isStaleReceipt(null, receipt())).toBe(false);
    expect(isStaleReceipt(receipt({ status: "recorded" }), receipt({ receiptId: "r-2" }))).toBe(false);
  });
});

describe("GovernanceVoteStatus requests", () => {
  it("runs one request at a time: a poll tick while one is pending starts no second", async () => {
    const { fn, calls } = controlledFetch();
    render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={1000} />);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => calls[0].resolve(receipt()));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("disables Refresh while a request is running", async () => {
    const { fn, calls } = controlledFetch();
    render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={0} />);
    await flush();
    await act(async () => calls[0].resolve(receipt()));
    await flush();

    const button = screen.getByRole("button", { name: /refresh vote status/i });
    fireEvent.click(button);
    await flush();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fn).toHaveBeenCalledTimes(2);

    await act(async () => calls[1].resolve(receipt({ reconciliationAttempts: 1 })));
    await flush();
    expect(screen.getByRole("button", { name: /refresh vote status/i })).not.toBeDisabled();
  });

  it("ignores a late reply for a receipt that is no longer shown", async () => {
    const { calls } = controlledFetch();
    const { rerender } = render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={0} />);
    await flush();
    rerender(<GovernanceVoteStatus receiptId="r-2" pollIntervalMs={0} />);
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/r-1");
    expect(calls[0].signal?.aborted).toBe(true);

    await act(async () => calls[1].resolve(receipt({ receiptId: "r-2", choice: "no", status: "recorded" })));
    await flush();
    // The first receipt's reply arrives last and must not replace the second.
    await act(async () => calls[0].resolve(receipt({ receiptId: "r-1", choice: "yes", status: "pending" })));
    await flush();

    expect(screen.getByRole("status", { name: /vote recorded on-chain/i })).toBeInTheDocument();
    expect(screen.getByText("no")).toBeInTheDocument();
    expect(screen.queryByText("yes")).not.toBeInTheDocument();
  });

  it("does not show the previous receipt while the next one loads", async () => {
    const { calls } = controlledFetch();
    const { rerender } = render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={0} />);
    await flush();
    await act(async () => calls[0].resolve(receipt({ status: "recorded" })));
    await flush();
    expect(screen.getByText("Vote recorded on-chain")).toBeInTheDocument();

    rerender(<GovernanceVoteStatus receiptId="r-2" pollIntervalMs={0} />);
    await flush();
    expect(screen.queryByText("Vote recorded on-chain")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading vote status")).toBeInTheDocument();
  });

  it("aborts the request when it unmounts and never updates afterwards", async () => {
    const { calls } = controlledFetch();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={0} />);
    await flush();
    unmount();
    expect(calls[0].signal?.aborted).toBe(true);

    await act(async () => calls[0].resolve(receipt({ status: "recorded" })));
    await flush();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("GovernanceVoteStatus state is preserved", () => {
  it("a lagging reply cannot move a recorded vote back to pending", async () => {
    const { calls } = controlledFetch();
    render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={1000} />);
    await flush();
    await act(async () => calls[0].resolve(receipt({ status: "recorded", recordedAt: "2026-01-01T00:01:00.000Z" })));
    await flush();
    expect(screen.getByText("Vote recorded on-chain")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    await act(async () => calls[1].resolve(receipt({ status: "pending" })));
    await flush();

    expect(screen.getByText("Vote recorded on-chain")).toBeInTheDocument();
    expect(screen.queryByText("Pending confirmation")).not.toBeInTheDocument();
  });

  it("a failed refresh keeps the last known status and says so", async () => {
    const { calls } = controlledFetch();
    render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={1000} />);
    await flush();
    await act(async () => calls[0].resolve(receipt({ status: "delayed" })));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    await act(async () => calls[1].fail(503));
    await flush();

    expect(screen.getByText("Indexing delayed — still waiting")).toBeInTheDocument();
    expect(screen.getByText(/Unable to load vote status\./)).toBeInTheDocument();
    expect(screen.getByText(/Showing the last known status/)).toBeInTheDocument();
  });

  it("recovers on the next successful refresh and clears the notice", async () => {
    const { calls } = controlledFetch();
    render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={1000} />);
    await flush();
    await act(async () => calls[0].resolve(receipt()));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    await act(async () => calls[1].reject());
    await flush();
    expect(screen.getByText(/Showing the last known status/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    await act(async () => calls[2].resolve(receipt({ status: "recorded", reconciliationAttempts: 1 })));
    await flush();
    expect(screen.getByText("Vote recorded on-chain")).toBeInTheDocument();
    expect(screen.queryByText(/Showing the last known status/)).not.toBeInTheDocument();
  });

  it("shows the error view when the first load fails", async () => {
    const { calls } = controlledFetch();
    render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={0} />);
    await flush();
    await act(async () => calls[0].fail(500));
    await flush();
    expect(screen.getByRole("alert", { name: /error loading vote status/i })).toBeInTheDocument();
  });

  it("a receipt that is gone (404) replaces the shown one", async () => {
    const { calls } = controlledFetch();
    render(<GovernanceVoteStatus receiptId="r-1" pollIntervalMs={1000} />);
    await flush();
    await act(async () => calls[0].resolve(receipt()));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    await act(async () => calls[1].fail(404));
    await flush();
    expect(screen.getByText("Vote receipt not found.")).toBeInTheDocument();
    expect(screen.queryByText("Pending confirmation")).not.toBeInTheDocument();
  });
});
