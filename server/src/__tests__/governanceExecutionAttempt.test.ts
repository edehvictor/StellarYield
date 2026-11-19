import {
  clearExecutionAttemptStore,
  countExecutionAttempts,
  getExecutionAttempt,
  listExecutionAttemptsForProposal,
  markExecutionFailed,
  markExecutionRolledBack,
  markExecutionSucceeded,
  recordExecutionAttempt,
  type GovernanceExecutionAttempt,
  type ExecutionAttemptStatus,
} from "../services/governanceExecutionAttemptService";

beforeEach(() => {
  clearExecutionAttemptStore();
});

const baseInput = {
  proposalId: "proposal-1",
  txHash: undefined,
  status: "submitted" as ExecutionAttemptStatus,
  phase: "submitting" as const,
};

describe("governanceExecutionAttemptService (#1899)", () => {
  describe("recordExecutionAttempt", () => {
    it("creates a submitted attempt with attempt number 1", () => {
      const attempt = recordExecutionAttempt({ ...baseInput });

      expect(attempt.proposalId).toBe("proposal-1");
      expect(attempt.status).toBe("submitted");
      expect(attempt.phase).toBe("submitting");
      expect(attempt.attemptNumber).toBe(1);
      expect(attempt.attemptId).toMatch(/^exec_/);
      expect(attempt.createdAt).toBeDefined();
      expect(attempt.updatedAt).toBeDefined();
      expect(attempt.completedAt).toBeUndefined();
      expect(countExecutionAttempts()).toBe(1);
    });

    it("increments the attempt number for a new attempt on the same proposal", () => {
      recordExecutionAttempt({ ...baseInput });
      recordExecutionAttempt({ ...baseInput });

      const third = recordExecutionAttempt({ ...baseInput });
      expect(third.attemptNumber).toBe(3);
      expect(countExecutionAttempts()).toBe(3);
    });

    it("keeps attempt numbers independent per proposal", () => {
      recordExecutionAttempt({ ...baseInput, proposalId: "p-a" });
      recordExecutionAttempt({ ...baseInput, proposalId: "p-b" });
      const secondA = recordExecutionAttempt({ ...baseInput, proposalId: "p-a" });

      expect(secondA.attemptNumber).toBe(2);
    });

    it("updates an existing attempt in place when the same txHash is reported again (no duplicate)", () => {
      const first = recordExecutionAttempt({
        ...baseInput,
        txHash: "abc123",
        status: "polling",
        phase: "polling",
      });

      const updated = recordExecutionAttempt({
        ...baseInput,
        txHash: "abc123",
        status: "failed",
        phase: "failure",
        error: "timeout",
      });

      expect(updated.attemptId).toBe(first.attemptId);
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("timeout");
      expect(updated.completedAt).toBeDefined();
      expect(countExecutionAttempts()).toBe(1);
    });

    it("defaults status to polling when a txHash is present", () => {
      const attempt = recordExecutionAttempt({
        proposalId: "proposal-1",
        txHash: "abc123",
      });

      expect(attempt.status).toBe("polling");
    });
  });

  describe("getExecutionAttempt", () => {
    it("returns the attempt by id", () => {
      const created = recordExecutionAttempt({ ...baseInput });
      const fetched = getExecutionAttempt(created.attemptId);

      expect(fetched?.attemptId).toBe(created.attemptId);
      expect(fetched?.proposalId).toBe("proposal-1");
    });

    it("returns undefined for an unknown id", () => {
      expect(getExecutionAttempt("exec_missing")).toBeUndefined();
    });
  });

  describe("listExecutionAttemptsForProposal", () => {
    it("lists attempts for a proposal newest first", () => {
      const first = recordExecutionAttempt({ ...baseInput, proposalId: "p-1" });
      recordExecutionAttempt({ ...baseInput, proposalId: "p-2" });
      const latest = recordExecutionAttempt({ ...baseInput, proposalId: "p-1" });

      const attempts = listExecutionAttemptsForProposal("p-1");
      expect(attempts).toHaveLength(2);
      expect(attempts.map((a) => a.attemptId).sort()).toEqual(
        [first.attemptId, latest.attemptId].sort(),
      );
      expect(attempts.every((a) => a.proposalId === "p-1")).toBe(true);
    });

    it("returns an empty array for an unknown proposal", () => {
      expect(listExecutionAttemptsForProposal("unknown")).toHaveLength(0);
    });
  });

  describe("terminal transitions", () => {
    it("markExecutionSucceeded flips an in-flight attempt to succeeded", () => {
      const created = recordExecutionAttempt({ ...baseInput, txHash: "abc123" });
      const updated = markExecutionSucceeded(created.attemptId, "abc123");

      expect(updated?.status).toBe("succeeded");
      expect(updated?.phase).toBe("success");
      expect(updated?.completedAt).toBeDefined();
    });

    it("markExecutionSucceeded is a no-op on an already terminal attempt", () => {
      const created = recordExecutionAttempt({ ...baseInput, txHash: "abc123" });
      markExecutionSucceeded(created.attemptId);
      const again = markExecutionSucceeded(created.attemptId);

      expect(again?.status).toBe("succeeded");
      expect(countExecutionAttempts()).toBe(1);
    });

    it("markExecutionFailed records the error and failed phase", () => {
      const created = recordExecutionAttempt({ ...baseInput, txHash: "abc123" });
      const updated = markExecutionFailed(created.attemptId, "node timeout", "polling");

      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("node timeout");
      expect(updated?.failedAtPhase).toBe("polling");
      expect(updated?.completedAt).toBeDefined();
    });

    it("markExecutionRolledBack flips an in-flight attempt to rolled_back but not a succeeded one", () => {
      const created = recordExecutionAttempt({ ...baseInput, txHash: "abc123" });
      const rolled = markExecutionRolledBack(created.attemptId);
      expect(rolled?.status).toBe("rolled_back");

      const succeeded = recordExecutionAttempt({
        ...baseInput,
        proposalId: "p-2",
        txHash: "def456",
        status: "succeeded",
        phase: "success",
      });
      const noOp = markExecutionRolledBack(succeeded.attemptId);
      expect(noOp?.status).toBe("succeeded");
    });

    it("all transition functions return undefined for a missing attempt", () => {
      expect(markExecutionSucceeded("missing")).toBeUndefined();
      expect(markExecutionFailed("missing", "x", "submitting")).toBeUndefined();
      expect(markExecutionRolledBack("missing")).toBeUndefined();
    });
  });
});
