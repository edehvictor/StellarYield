import { describe, it, expect, beforeEach } from "vitest";
import {
  TX_PHASE_PIPELINE,
  TX_PHASE_SUBMIT_POLL,
  TX_PHASE_RECOVERY,
  TX_PHASE_LABELS,
  stepIndexIn,
  isStepCompleted,
  isStepActive,
  isTerminalPhase,
  createDepositReceipt,
  updateReceiptFromEvent,
  markReceiptDuplicate,
  saveTransactionDraft,
  getTransactionDraft,
  clearPendingTransactionDrafts,
} from "./transactionPhase";

describe("transactionPhase helpers", () => {
  it("marks success as past all steps", () => {
    expect(stepIndexIn(TX_PHASE_PIPELINE, "success")).toBe(TX_PHASE_PIPELINE.length);
  });

  it("resolves active indices in the full pipeline", () => {
    expect(stepIndexIn(TX_PHASE_PIPELINE, "building")).toBe(0);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "simulating")).toBe(1);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "waiting_for_wallet")).toBe(2);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "submitting")).toBe(3);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "polling")).toBe(4);
  });

  it("does not match idle or failure to a step index", () => {
    expect(stepIndexIn(TX_PHASE_PIPELINE, "idle")).toBe(-1);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "failure")).toBe(-1);
  });

  it("computes completed vs active steps during waiting_for_wallet", () => {
    const phase = "waiting_for_wallet";
    expect(isStepCompleted(TX_PHASE_PIPELINE, phase, 0)).toBe(true);
    expect(isStepCompleted(TX_PHASE_PIPELINE, phase, 1)).toBe(true);
    expect(isStepCompleted(TX_PHASE_PIPELINE, phase, 2)).toBe(false);
    expect(isStepActive(TX_PHASE_PIPELINE, phase, 2)).toBe(true);
    expect(isStepActive(TX_PHASE_PIPELINE, phase, 3)).toBe(false);
  });

  it("marks all steps complete on success", () => {
    for (let i = 0; i < TX_PHASE_PIPELINE.length; i++) {
      expect(isStepCompleted(TX_PHASE_PIPELINE, "success", i)).toBe(true);
    }
  });

  it("submit/poll preset has two steps", () => {
    expect(TX_PHASE_SUBMIT_POLL).toEqual(["submitting", "polling"]);
  });

  it("detects terminal phases", () => {
    expect(isTerminalPhase("success")).toBe(true);
    expect(isTerminalPhase("failure")).toBe(true);
    expect(isTerminalPhase("polling")).toBe(false);
  });

  it("treats 'recovering' as a non-terminal phase with a label", () => {
    expect(isTerminalPhase("recovering")).toBe(false);
    expect(TX_PHASE_LABELS.recovering).toBeTruthy();
  });

  it("exposes a single-step recovery pipeline", () => {
    expect(TX_PHASE_RECOVERY).toEqual(["recovering"]);
    expect(stepIndexIn(TX_PHASE_RECOVERY, "recovering")).toBe(0);
  });
});

describe("deposit receipt tracking", () => {
  it("creates a pending receipt", () => {
    const receipt = createDepositReceipt("tx_abc", "vault-1", "USDC", 1000);
    expect(receipt.status).toBe("pending");
    expect(receipt.txHash).toBe("tx_abc");
    expect(receipt.amount).toBe(1000);
    expect(receipt.submittedAt).toBeTruthy();
  });

  it("confirms receipt when event amount matches", () => {
    const receipt = createDepositReceipt("tx_abc", "vault-1", "USDC", 1000);
    const updated = updateReceiptFromEvent(receipt, {
      eventId: "evt_001",
      amount: 1000,
      sharesAssigned: 950,
      processedAt: "2024-01-15T10:01:00Z",
    });
    expect(updated.status).toBe("confirmed");
    expect(updated.indexedEventId).toBe("evt_001");
    expect(updated.sharesAssigned).toBe(950);
  });

  it("marks receipt mismatched when amount differs", () => {
    const receipt = createDepositReceipt("tx_abc", "vault-1", "USDC", 1000);
    const updated = updateReceiptFromEvent(receipt, {
      eventId: "evt_001",
      amount: 999,
      sharesAssigned: 949,
      processedAt: "2024-01-15T10:01:00Z",
    });
    expect(updated.status).toBe("mismatched");
    expect(updated.mismatchReason).toBe("amount_mismatch");
  });

  it("marks receipt as duplicate mismatched", () => {
    const receipt = createDepositReceipt("tx_abc", "vault-1", "USDC", 1000);
    const updated = markReceiptDuplicate(receipt, ["evt_001", "evt_002"]);
    expect(updated.status).toBe("mismatched");
    expect(updated.mismatchReason).toBe("duplicate_events");
    expect(updated.indexedEventId).toBe("evt_001");
  });

  it("handles delayed confirmation correctly", () => {
    const receipt = createDepositReceipt("tx_abc", "vault-1", "USDC", 1000);
    const updated = updateReceiptFromEvent(receipt, {
      eventId: "evt_001",
      amount: 1000,
      sharesAssigned: 950,
      processedAt: "2024-01-15T10:05:00Z",
    });
    expect(updated.status).toBe("confirmed");
    expect(updated.confirmedAt).toBe("2024-01-15T10:05:00Z");
  });
});

describe("draft state management via transactionPhase", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saves and retrieves draft for specific wallet", () => {
    saveTransactionDraft("G_WALLET_1", {
      id: "tx-draft-1",
      action: "withdraw",
      amount: 50,
      status: "draft",
    });

    const draft = getTransactionDraft("G_WALLET_1");
    expect(draft).not.toBeNull();
    expect(draft?.id).toBe("tx-draft-1");

    // Foreign wallet cannot retrieve it
    expect(getTransactionDraft("G_WALLET_2")).toBeNull();
  });

  it("clears pending drafts on command", () => {
    saveTransactionDraft("G_WALLET_1", {
      id: "tx-draft-1",
      action: "deposit",
      amount: 100,
      status: "draft",
    });

    clearPendingTransactionDrafts();
    expect(getTransactionDraft("G_WALLET_1")).toBeNull();
  });
});


