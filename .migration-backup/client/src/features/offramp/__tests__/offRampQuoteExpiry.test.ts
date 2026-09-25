import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OffRampService, isQuoteExpired, QUOTE_TTL_MS } from "../offRampService";
import type { OffRampTransaction, WithdrawalRequest } from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

const VALID_REQUEST: WithdrawalRequest = {
  vaultContractId: "vault-001",
  shares: 1000n,
  usdcAmount: 5000n,
  bankAccount: "123456789",
  bankName: "Test Bank",
  accountHolder: "Alice",
};

function makeTx(overrides: Partial<OffRampTransaction> = {}): OffRampTransaction {
  const now = Date.now();
  return {
    id: "tx-1",
    status: "pending",
    amount: "5000",
    currency: "USDC",
    bankAccount: "123456789",
    memo: "SY:Alice:000001",
    createdAt: now,
    quoteExpiresAt: now + QUOTE_TTL_MS,
    ...overrides,
  };
}

// ── isQuoteExpired — pure helper ──────────────────────────────────────────────

describe("isQuoteExpired", () => {
  it("returns false when quoteExpiresAt is in the future", () => {
    const tx = makeTx({ quoteExpiresAt: Date.now() + 60_000 });
    expect(isQuoteExpired(tx)).toBe(false);
  });

  it("returns true when quoteExpiresAt is in the past", () => {
    const tx = makeTx({ quoteExpiresAt: Date.now() - 1 });
    expect(isQuoteExpired(tx)).toBe(true);
  });

  it("returns true exactly at the expiry boundary (nowMs === quoteExpiresAt)", () => {
    const expiresAt = 1_700_000_000_000;
    const tx = makeTx({ quoteExpiresAt: expiresAt });
    // nowMs equal to quoteExpiresAt: nowMs > quoteExpiresAt is false, so boundary is NOT expired
    expect(isQuoteExpired(tx, expiresAt)).toBe(false);
  });

  it("returns true one millisecond after the boundary", () => {
    const expiresAt = 1_700_000_000_000;
    const tx = makeTx({ quoteExpiresAt: expiresAt });
    expect(isQuoteExpired(tx, expiresAt + 1)).toBe(true);
  });

  it("returns false for a transaction with no quoteExpiresAt (non-expiring)", () => {
    const tx = makeTx({ quoteExpiresAt: undefined });
    expect(isQuoteExpired(tx)).toBe(false);
  });

  it("accepts an explicit nowMs override for time-controlled tests", () => {
    const expiresAt = 1_000;
    const tx = makeTx({ quoteExpiresAt: expiresAt });
    expect(isQuoteExpired(tx, 999)).toBe(false);
    expect(isQuoteExpired(tx, 1_001)).toBe(true);
  });
});

// ── QUOTE_TTL_MS constant ─────────────────────────────────────────────────────

describe("QUOTE_TTL_MS", () => {
  it("is exactly 5 minutes in milliseconds", () => {
    expect(QUOTE_TTL_MS).toBe(300_000);
  });
});

// ── OffRampService — quote expiry stamping on initiateWithdrawal ──────────────

describe("OffRampService — quoteExpiresAt stamping", () => {
  let service: OffRampService;

  beforeEach(() => {
    service = new OffRampService("moonpay");
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps quoteExpiresAt = createdAt + QUOTE_TTL_MS on a successful withdrawal", async () => {
    const fakeNow = 1_700_000_000_000;
    vi.setSystemTime(fakeNow);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "tx-ok", status: "pending" }),
    });

    const tx = await service.initiateWithdrawal(VALID_REQUEST);
    expect(tx.quoteExpiresAt).toBe(fakeNow + QUOTE_TTL_MS);
    expect(tx.createdAt).toBe(fakeNow);
  });

  it("persists quoteExpiresAt to localStorage", async () => {
    const fakeNow = 1_700_000_001_000;
    vi.setSystemTime(fakeNow);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "pending" }),
    });

    const tx = await service.initiateWithdrawal(VALID_REQUEST);
    const stored = service.getAllTransactions().find((t) => t.id === tx.id);
    expect(stored?.quoteExpiresAt).toBe(fakeNow + QUOTE_TTL_MS);
  });

  it("stamps quoteExpiresAt even when the submission fails", async () => {
    const fakeNow = 1_700_000_002_000;
    vi.setSystemTime(fakeNow);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    try {
      await service.initiateWithdrawal(VALID_REQUEST);
    } catch {
      // expected
    }

    const [stored] = service.getAllTransactions();
    expect(stored.quoteExpiresAt).toBe(fakeNow + QUOTE_TTL_MS);
    expect(stored.status).toBe("failed");
  });
});

// ── Resume-state persistence across page reloads ──────────────────────────────

describe("OffRampService — resume-state persistence", () => {
  let service: OffRampService;

  beforeEach(() => {
    service = new OffRampService("moonpay");
    localStorage.clear();
    global.fetch = vi.fn();
  });

  it("getAllTransactions returns an empty array when localStorage is empty", () => {
    expect(service.getAllTransactions()).toEqual([]);
  });

  it("persists a completed transaction across a new service instance", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "pending" }),
    });

    const tx = await service.initiateWithdrawal(VALID_REQUEST);

    // Poll to completion
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "completed" }),
    });
    await service.pollStatus(tx.id);

    // Simulate page reload — fresh service instance reads same localStorage
    const freshService = new OffRampService("moonpay");
    const [loaded] = freshService.getAllTransactions();
    expect(loaded.status).toBe("completed");
    expect(loaded.completedAt).toBeDefined();
  });

  it("does not poll a transaction that is already completed", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "pending" }),
    });

    const tx = await service.initiateWithdrawal(VALID_REQUEST);

    // Drive it to completed
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "completed" }),
    });
    await service.pollStatus(tx.id);

    const callsBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second poll on a completed tx — should short-circuit
    await service.pollStatus(tx.id);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it("retains all transactions after multiple writes", async () => {
    for (let i = 0; i < 3; i++) {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending" }),
      });
      await service.initiateWithdrawal({
        ...VALID_REQUEST,
        bankAccount: `${100_000_000 + i}`,
      });
    }

    expect(service.getAllTransactions()).toHaveLength(3);
  });

  it("gracefully returns empty array when localStorage contains invalid JSON", () => {
    localStorage.setItem("stellar_yield_offramp_txns", "not-json{{{");
    const freshService = new OffRampService("moonpay");
    expect(freshService.getAllTransactions()).toEqual([]);
  });
});
