import {
  EventCursorError,
  computeEventPageCheckpoint,
  extractRpcCursor,
  type EventPageCheckpoint,
} from "../indexer/eventCursorCheckpoint";

describe("computeEventPageCheckpoint", () => {
  const baseInput = {
    lastLedger: 100,
    endLedger: 200,
    limit: 2,
  };

  it("advances to the last event ledger and keeps a full page cursor", () => {
    const outcome = computeEventPageCheckpoint({
      ...baseInput,
      events: [{ ledger: 101 }, { ledger: 102 }],
      rpcCursor: "cursor-abc",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.checkpoint).toEqual<EventPageCheckpoint>({
      lastLedger: 102,
      cursorPosition: "cursor-abc",
      hasMorePages: true,
    });
  });

  it("clears the cursor when the final partial page is ingested", () => {
    const outcome = computeEventPageCheckpoint({
      ...baseInput,
      events: [{ ledger: 101 }],
      rpcCursor: "cursor-abc",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.checkpoint).toEqual<EventPageCheckpoint>({
      lastLedger: 101,
      cursorPosition: null,
      hasMorePages: false,
    });
  });

  it("jumps to endLedger when a page contains no events", () => {
    const outcome = computeEventPageCheckpoint({
      ...baseInput,
      events: [],
      rpcCursor: null,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.checkpoint).toEqual<EventPageCheckpoint>({
      lastLedger: 200,
      cursorPosition: null,
      hasMorePages: false,
    });
  });

  it("returns MISSING_CURSOR when a full page has no pagination cursor", () => {
    const outcome = computeEventPageCheckpoint({
      ...baseInput,
      events: [{ ledger: 101 }, { ledger: 102 }],
      rpcCursor: null,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(EventCursorError);
    expect(outcome.error.code).toBe("MISSING_CURSOR");
    expect(outcome.error.meta?.limit).toBe(2);
  });

  it("returns LEDGER_REGRESSION when events do not advance past the checkpoint", () => {
    const outcome = computeEventPageCheckpoint({
      ...baseInput,
      events: [{ ledger: 100 }],
      rpcCursor: "cursor-abc",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("LEDGER_REGRESSION");
  });

  it("returns a resumable checkpoint that resumes the identical page window", () => {
    const first = computeEventPageCheckpoint({
      ...baseInput,
      events: [{ ledger: 101 }, { ledger: 102 }],
      rpcCursor: "cursor-resume",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Replaying with the restored cursor must advance again (no gap re-scan).
    const second = computeEventPageCheckpoint({
      lastLedger: first.checkpoint.lastLedger,
      endLedger: 205,
      events: [{ ledger: 103 }, { ledger: 104 }],
      rpcCursor: "cursor-resume-2",
      limit: 2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.checkpoint.lastLedger).toBe(104);
    expect(second.checkpoint.cursorPosition).toBe("cursor-resume-2");
  });
});

describe("extractRpcCursor", () => {
  it("returns the cursor when present", () => {
    expect(extractRpcCursor({ cursor: "abc" })).toBe("abc");
  });

  it("returns null for missing, empty, or undefined cursors", () => {
    expect(extractRpcCursor({})).toBeNull();
    expect(extractRpcCursor({ cursor: "" })).toBeNull();
    expect(extractRpcCursor(null)).toBeNull();
    expect(extractRpcCursor(undefined)).toBeNull();
  });
});