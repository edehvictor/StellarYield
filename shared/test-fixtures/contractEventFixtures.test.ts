/**
 * Tests for the contract event fixture generator (issue #1396).
 */
import { describe, it, expect } from "vitest";
import {
  makeDepositEvent,
  makeWithdrawalEvent,
  makeRebalanceEvent,
  makeHarvestEvent,
  makeAdminActionEvent,
  makePauseEvent,
  makeUnpauseEvent,
  makeShareTransferEvent,
  makeInitEvent,
  makeReferralEvent,
  makeFlashLoanEvent,
  makeVaultEventBatch,
  makeUnknownEvent,
  DEFAULT_CONTRACT_ID,
  DEFAULT_LEDGER,
} from "./contractEventFixtures";

// ── Topic correctness ─────────────────────────────────────────────────────────

describe("individual event builders", () => {
  it("makeDepositEvent produces dep_for topic with required fields", () => {
    const evt = makeDepositEvent();
    expect(evt.topic).toBe("dep_for");
    expect(evt.schemaVersion).toBe(1);
    expect(typeof evt.data["depositor"]).toBe("string");
    expect(typeof evt.data["amount_usdc"]).toBe("number");
    expect(typeof evt.data["shares_issued"]).toBe("number");
  });

  it("makeWithdrawalEvent produces with topic", () => {
    const evt = makeWithdrawalEvent();
    expect(evt.topic).toBe("with");
    expect(typeof evt.data["withdrawer"]).toBe("string");
    expect(typeof evt.data["shares_burned"]).toBe("number");
  });

  it("makeRebalanceEvent produces rebal topic with allocations", () => {
    const evt = makeRebalanceEvent();
    expect(evt.topic).toBe("rebal");
    expect(Array.isArray(evt.data["allocations"])).toBe(true);
  });

  it("makeHarvestEvent produces harvest topic", () => {
    const evt = makeHarvestEvent();
    expect(evt.topic).toBe("harvest");
    expect(typeof evt.data["yield_usdc"]).toBe("number");
    expect(typeof evt.data["fees_usdc"]).toBe("number");
  });

  it("makePauseEvent and makeUnpauseEvent produce correct topics", () => {
    expect(makePauseEvent().topic).toBe("pause");
    expect(makeUnpauseEvent().topic).toBe("unpause");
  });

  it("makeAdminActionEvent produces admin_action topic", () => {
    expect(makeAdminActionEvent().topic).toBe("admin_action");
  });

  it("makeShareTransferEvent produces tr_sh topic", () => {
    expect(makeShareTransferEvent().topic).toBe("tr_sh");
  });

  it("makeInitEvent produces init topic", () => {
    expect(makeInitEvent().topic).toBe("init");
  });

  it("makeReferralEvent produces referral topic", () => {
    expect(makeReferralEvent().topic).toBe("referral");
  });

  it("makeFlashLoanEvent produces flash topic", () => {
    expect(makeFlashLoanEvent().topic).toBe("flash");
  });
});

// ── Option overrides ──────────────────────────────────────────────────────────

describe("option overrides", () => {
  const CUSTOM_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";

  it("contractId override is respected", () => {
    const evt = makeDepositEvent({ contractId: CUSTOM_ID });
    expect(evt.contractId).toBe(CUSTOM_ID);
  });

  it("ledger override is respected", () => {
    const evt = makeDepositEvent({ ledger: 42 });
    expect(evt.ledger).toBe(42);
  });

  it("txHash override is respected and bypasses synthetic hash", () => {
    const evt = makeDepositEvent({ txHash: "deadbeef" });
    expect(evt.txHash).toBe("deadbeef");
  });

  it("depositor override propagates to data", () => {
    const depositor = "GCUSTOM000000000000000000000000000000000000000000000001";
    const evt = makeDepositEvent({ depositor });
    expect(evt.data["depositor"]).toBe(depositor);
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────

describe("determinism", () => {
  it("same options always produce the same txHash", () => {
    const a = makeDepositEvent({ ledger: 999 });
    const b = makeDepositEvent({ ledger: 999 });
    expect(a.txHash).toBe(b.txHash);
  });

  it("different ledgers produce different txHashes", () => {
    const a = makeDepositEvent({ ledger: 100 });
    const b = makeDepositEvent({ ledger: 101 });
    expect(a.txHash).not.toBe(b.txHash);
  });

  it("different topics produce different txHashes at the same ledger", () => {
    const dep = makeDepositEvent({ ledger: 200 });
    const wit = makeWithdrawalEvent({ ledger: 200 });
    expect(dep.txHash).not.toBe(wit.txHash);
  });
});

// ── Default values ────────────────────────────────────────────────────────────

describe("default values", () => {
  it("uses DEFAULT_CONTRACT_ID when no contractId given", () => {
    expect(makeDepositEvent().contractId).toBe(DEFAULT_CONTRACT_ID);
  });

  it("uses DEFAULT_LEDGER when no ledger given", () => {
    expect(makeDepositEvent().ledger).toBe(DEFAULT_LEDGER);
  });
});

// ── Batch builder ─────────────────────────────────────────────────────────────

describe("makeVaultEventBatch", () => {
  it("returns one fixture per recognized topic", () => {
    const batch = makeVaultEventBatch();
    expect(batch.length).toBeGreaterThanOrEqual(10);
  });

  it("all fixtures share the specified contractId", () => {
    const id = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";
    const batch = makeVaultEventBatch({ contractId: id });
    expect(batch.every((e) => e.contractId === id)).toBe(true);
  });

  it("ledgers are consecutive starting from baseLedger", () => {
    const batch = makeVaultEventBatch({ baseLedger: 5000 });
    batch.forEach((evt, i) => expect(evt.ledger).toBe(5000 + i));
  });

  it("covers all recognized topics from events.rs", () => {
    const RECOGNIZED = new Set([
      "init", "dep_for", "rebal", "tr_sh", "harvest",
      "admin_action", "pause", "unpause", "referral", "flash", "with",
    ]);
    const batch = makeVaultEventBatch();
    const covered = new Set(batch.map((e) => e.topic));
    for (const topic of RECOGNIZED) {
      expect(covered.has(topic)).toBe(true);
    }
  });

  it("each fixture has schemaVersion 1", () => {
    const batch = makeVaultEventBatch();
    expect(batch.every((e) => e.schemaVersion === 1)).toBe(true);
  });
});

// ── Unknown / dead-letter fixture ─────────────────────────────────────────────

describe("makeUnknownEvent", () => {
  it("produces a fixture that is not in the recognized topic set", () => {
    const RECOGNIZED = new Set([
      "init", "dep_for", "rebal", "tr_sh", "harvest",
      "admin_action", "pause", "unpause", "referral", "flash", "with",
      "deposit", "withdrawal",
    ]);
    const evt = makeUnknownEvent();
    expect(RECOGNIZED.has(evt.topic)).toBe(false);
  });

  it("allows a custom topic for future-version simulation", () => {
    const evt = makeUnknownEvent({ topic: "new_feature_v2" });
    expect(evt.topic).toBe("new_feature_v2");
  });
});
