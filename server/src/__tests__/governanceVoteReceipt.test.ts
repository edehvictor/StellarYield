import {
  submitVoteReceipt,
  submitVoteReceiptOnce,
  reconcileVoteReceipts,
  getVoteReceipt,
  listVoteReceipts,
  clearReceiptStore,
  type IndexedGovernanceEvent,
} from "../services/governanceVoteReceiptService";

beforeEach(() => {
  clearReceiptStore();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("governanceVoteReceiptService (#1190)", () => {
  describe("submitVoteReceipt", () => {
    it("creates a pending receipt on submission", () => {
      const receipt = submitVoteReceipt("proposal-1", "GABC", "yes");
      expect(receipt.status).toBe("pending");
      expect(receipt.proposalId).toBe("proposal-1");
      expect(receipt.voter).toBe("GABC");
      expect(receipt.choice).toBe("yes");
      expect(receipt.reconciliationAttempts).toBe(0);
      expect(receipt.recordedAt).toBeUndefined();
      expect(receipt.failureReason).toBeUndefined();
    });

    it("assigns a unique receiptId per distinct vote, even within one millisecond", () => {
      // Fake timers freeze Date.now(), so ids must not depend on the clock alone.
      const r1 = submitVoteReceipt("p-1", "GABC", "yes");
      const r2 = submitVoteReceipt("p-1", "GDEF", "yes");
      const r3 = submitVoteReceipt("p-2", "GABC", "yes");
      expect(new Set([r1.receiptId, r2.receiptId, r3.receiptId]).size).toBe(3);
      expect(listVoteReceipts("p-1")).toHaveLength(2);
    });
  });

  describe("safe retries (#1896)", () => {
    it("returns the existing receipt when the same vote is submitted again", () => {
      const first = submitVoteReceiptOnce("p-1", "GABC", "yes");
      const retry = submitVoteReceiptOnce("p-1", "GABC", "yes");

      expect(first.outcome).toBe("created");
      expect(retry.outcome).toBe("replayed");
      expect(retry.receipt.receiptId).toBe(first.receipt.receiptId);
      expect(listVoteReceipts("p-1")).toHaveLength(1);
    });

    it("submitVoteReceipt resolves a retry to the same receipt", () => {
      const r1 = submitVoteReceipt("p-1", "GABC", "yes");
      const r2 = submitVoteReceipt("p-1", "GABC", "yes");
      expect(r2.receiptId).toBe(r1.receiptId);
      expect(listVoteReceipts("p-1")).toHaveLength(1);
    });

    it("rejects a different choice for a vote that is already in flight and keeps the receipt", () => {
      const first = submitVoteReceiptOnce("p-1", "GABC", "yes");
      const conflict = submitVoteReceiptOnce("p-1", "GABC", "no");

      expect(conflict.outcome).toBe("conflict");
      expect(conflict.receipt.receiptId).toBe(first.receipt.receiptId);
      expect(conflict.receipt.choice).toBe("yes");
      const stored = listVoteReceipts("p-1");
      expect(stored).toHaveLength(1);
      expect(stored[0].choice).toBe("yes");
    });

    it("keeps a recorded vote final: a retry replays it and a new choice conflicts", () => {
      submitVoteReceipt("p-1", "GABC", "yes");
      reconcileVoteReceipts([
        { proposalId: "p-1", voter: "GABC", choice: "yes", txHash: "TX1", indexedAt: new Date().toISOString() },
      ]);

      expect(submitVoteReceiptOnce("p-1", "GABC", "yes").outcome).toBe("replayed");
      const conflict = submitVoteReceiptOnce("p-1", "GABC", "no");
      expect(conflict.outcome).toBe("conflict");
      expect(conflict.receipt.status).toBe("recorded");
      expect(listVoteReceipts("p-1")).toHaveLength(1);
    });

    it("treats a delayed vote as still in flight", () => {
      submitVoteReceipt("p-1", "GABC", "yes");
      jest.advanceTimersByTime(6 * 60 * 1000);

      const retry = submitVoteReceiptOnce("p-1", "GABC", "yes");
      expect(retry.outcome).toBe("replayed");
      expect(retry.receipt.status).toBe("delayed");
    });

    it("lets the voter resubmit once the earlier receipt failed", () => {
      const first = submitVoteReceipt("p-1", "GABC", "yes");
      jest.advanceTimersByTime(31 * 60 * 1000);
      reconcileVoteReceipts([]); // pending -> failed

      const again = submitVoteReceiptOnce("p-1", "GABC", "no");
      expect(again.outcome).toBe("created");
      expect(again.receipt.receiptId).not.toBe(first.receiptId);
      expect(again.receipt.status).toBe("pending");
      expect(getVoteReceipt(first.receiptId)?.status).toBe("failed");
    });

    it("does not confuse voters or proposals that share a prefix", () => {
      const a = submitVoteReceiptOnce("p:1", "GABC", "yes");
      const b = submitVoteReceiptOnce("p", "1:GABC", "yes");
      expect(a.outcome).toBe("created");
      expect(b.outcome).toBe("created");
      expect(a.receipt.receiptId).not.toBe(b.receipt.receiptId);
    });

    it("lets different voters vote on the same proposal", () => {
      expect(submitVoteReceiptOnce("p-1", "GABC", "yes").outcome).toBe("created");
      expect(submitVoteReceiptOnce("p-1", "GDEF", "no").outcome).toBe("created");
      expect(listVoteReceipts("p-1")).toHaveLength(2);
    });
  });

  describe("reconcileVoteReceipts — match found", () => {
    it("transitions a pending receipt to recorded when an event matches", () => {
      const receipt = submitVoteReceipt("proposal-1", "GABC", "yes");

      const events: IndexedGovernanceEvent[] = [
        {
          proposalId: "proposal-1",
          voter: "GABC",
          choice: "yes",
          txHash: "TX123",
          indexedAt: new Date().toISOString(),
        },
      ];

      const updated = reconcileVoteReceipts(events);
      expect(updated).toHaveLength(1);
      expect(updated[0].receiptId).toBe(receipt.receiptId);
      expect(updated[0].status).toBe("recorded");
      expect(updated[0].recordedAt).toBeDefined();
    });

    it("does not change status of already-recorded receipts", () => {
      const receipt = submitVoteReceipt("p-2", "GABC", "no");

      const events: IndexedGovernanceEvent[] = [
        { proposalId: "p-2", voter: "GABC", choice: "no", txHash: "TX456", indexedAt: new Date().toISOString() },
      ];

      reconcileVoteReceipts(events); // first pass → recorded
      const updated = reconcileVoteReceipts(events); // second pass → skip
      expect(updated.find((r) => r.receiptId === receipt.receiptId)).toBeUndefined();
    });
  });

  describe("reconcileVoteReceipts — no match", () => {
    it("stays pending within the delay threshold", () => {
      submitVoteReceipt("p-3", "GABC", "abstain");
      const updated = reconcileVoteReceipts([]);
      expect(updated[0].status).toBe("pending");
    });

    it("transitions to delayed after the delay threshold", () => {
      submitVoteReceipt("p-4", "GABC", "yes");
      // Advance past VOTE_RECEIPT_DELAY_THRESHOLD_MS (default 5 min)
      jest.advanceTimersByTime(6 * 60 * 1000);
      const updated = reconcileVoteReceipts([]);
      expect(updated[0].status).toBe("delayed");
    });

    it("transitions to failed after the failure threshold", () => {
      submitVoteReceipt("p-5", "GABC", "no");
      // Advance past VOTE_RECEIPT_FAILURE_THRESHOLD_MS (default 30 min)
      jest.advanceTimersByTime(31 * 60 * 1000);
      const updated = reconcileVoteReceipts([]);
      expect(updated[0].status).toBe("failed");
      expect(updated[0].failureReason).toBeTruthy();
    });
  });

  describe("getVoteReceipt", () => {
    it("returns the receipt by ID", () => {
      const receipt = submitVoteReceipt("p-6", "GABC", "yes");
      const fetched = getVoteReceipt(receipt.receiptId);
      expect(fetched?.receiptId).toBe(receipt.receiptId);
    });

    it("returns undefined for an unknown ID", () => {
      expect(getVoteReceipt("unknown-id")).toBeUndefined();
    });
  });

  describe("listVoteReceipts", () => {
    it("lists all receipts for a proposal", () => {
      submitVoteReceipt("p-7", "GABC", "yes");
      submitVoteReceipt("p-7", "GDEF", "no");
      submitVoteReceipt("p-8", "GABC", "yes");

      const results = listVoteReceipts("p-7");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.proposalId === "p-7")).toBe(true);
    });

    it("filters by voter when provided", () => {
      submitVoteReceipt("p-9", "GABC", "yes");
      submitVoteReceipt("p-9", "GDEF", "no");

      const results = listVoteReceipts("p-9", "GABC");
      expect(results).toHaveLength(1);
      expect(results[0].voter).toBe("GABC");
    });

    it("returns empty array for unknown proposalId", () => {
      expect(listVoteReceipts("nonexistent")).toHaveLength(0);
    });
  });
});
