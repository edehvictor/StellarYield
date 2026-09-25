/**
 * Deposit draft persistence and reload reconciliation (#1146).
 *
 * Covers the three reload scenarios from the issue:
 *  - reload before submission (no draft, or a draft with no tx hash yet)
 *  - reload after submission but before confirmation (pending)
 *  - reload after confirmation (confirmed, and the draft is cleaned up)
 * plus staleness cleanup for an abandoned draft that never confirmed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEPOSIT_DRAFT_STALE_MS,
  saveDepositDraft,
  loadDepositDraft,
  clearDepositDraft,
  reconcileDepositDraft,
  fetchDepositStatus,
  type DepositDraft,
} from "./depositDraft";

const WALLET = "GABCDEF1234567890";

function makeDraft(overrides: Partial<DepositDraft> = {}): DepositDraft {
  return {
    amount: "100",
    vaultContractId: "CVAULT",
    vaultTokenSymbol: "yVault",
    inputTokenContract: "CXLM",
    inputTokenSymbol: "XLM",
    submittedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("saveDepositDraft / loadDepositDraft / clearDepositDraft", () => {
  it("round-trips a saved draft", () => {
    const draft = makeDraft({ txHash: "a".repeat(64) });
    saveDepositDraft(WALLET, draft);
    expect(loadDepositDraft(WALLET)).toEqual(draft);
  });

  it("returns null when nothing is persisted", () => {
    expect(loadDepositDraft(WALLET)).toBeNull();
  });

  it("returns null for a malformed stored value instead of throwing", () => {
    localStorage.setItem(`deposit_draft_${WALLET}`, "{not valid json");
    expect(loadDepositDraft(WALLET)).toBeNull();
  });

  it("returns null for a well-formed but incomplete stored value", () => {
    localStorage.setItem(`deposit_draft_${WALLET}`, JSON.stringify({ amount: "100" }));
    expect(loadDepositDraft(WALLET)).toBeNull();
  });

  it("clears a persisted draft", () => {
    saveDepositDraft(WALLET, makeDraft());
    clearDepositDraft(WALLET);
    expect(loadDepositDraft(WALLET)).toBeNull();
  });

  it("scopes drafts per wallet address", () => {
    saveDepositDraft(WALLET, makeDraft({ amount: "1" }));
    saveDepositDraft("GOTHERWALLET", makeDraft({ amount: "2" }));
    expect(loadDepositDraft(WALLET)?.amount).toBe("1");
    expect(loadDepositDraft("GOTHERWALLET")?.amount).toBe("2");
  });
});

describe("fetchDepositStatus", () => {
  it("returns the parsed status on a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ txHash: "abc", status: "confirmed", amount: 100 }),
    });
    const result = await fetchDepositStatus("abc", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ txHash: "abc", status: "confirmed", amount: 100 });
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const result = await fetchDepositStatus("abc", fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network failure)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await fetchDepositStatus("abc", fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("returns null for a malformed response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nonsense: true }) });
    const result = await fetchDepositStatus("abc", fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });
});

describe("reconcileDepositDraft", () => {
  it("reload before submission — no persisted draft resolves to none", async () => {
    const fetchImpl = vi.fn();
    const state = await reconcileDepositDraft(WALLET, { fetchImpl });
    expect(state).toEqual({ kind: "none" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reload before submission completed — a draft with no tx hash resolves to none and is cleared", async () => {
    saveDepositDraft(WALLET, makeDraft()); // no txHash
    const fetchImpl = vi.fn();
    const state = await reconcileDepositDraft(WALLET, { fetchImpl });
    expect(state).toEqual({ kind: "none" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadDepositDraft(WALLET)).toBeNull();
  });

  it("reload after submission but before confirmation — indexer reports pending, draft is kept", async () => {
    const draft = makeDraft({ txHash: "b".repeat(64) });
    saveDepositDraft(WALLET, draft);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ txHash: draft.txHash, status: "pending" }),
    });

    const state = await reconcileDepositDraft(WALLET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state).toEqual({ kind: "pending", draft });
    expect(loadDepositDraft(WALLET)).toEqual(draft); // still persisted
  });

  it("reload after confirmation — indexer reports confirmed, UI gets receipt data and draft is cleaned up", async () => {
    const draft = makeDraft({ txHash: "c".repeat(64) });
    saveDepositDraft(WALLET, draft);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        txHash: draft.txHash,
        status: "confirmed",
        amount: 100,
        shares: 98.5,
        confirmedAt: "2026-01-01T00:00:00.000Z",
      }),
    });

    const state = await reconcileDepositDraft(WALLET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state).toEqual({
      kind: "confirmed",
      draft,
      confirmedAmount: 100,
      confirmedShares: 98.5,
      confirmedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(loadDepositDraft(WALLET)).toBeNull(); // cleaned up
  });

  it("treats a still-pending draft older than the staleness window as abandoned and cleans it up", async () => {
    const draft = makeDraft({
      txHash: "d".repeat(64),
      submittedAt: Date.now() - (DEPOSIT_DRAFT_STALE_MS + 1),
    });
    saveDepositDraft(WALLET, draft);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ txHash: draft.txHash, status: "pending" }),
    });

    const state = await reconcileDepositDraft(WALLET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state).toEqual({ kind: "stale", draft });
    expect(loadDepositDraft(WALLET)).toBeNull();
  });

  it("keeps a not-yet-stale pending draft as pending even when the status lookup fails", async () => {
    const draft = makeDraft({ txHash: "e".repeat(64) });
    saveDepositDraft(WALLET, draft);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const state = await reconcileDepositDraft(WALLET, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(state).toEqual({ kind: "pending", draft });
  });
});
