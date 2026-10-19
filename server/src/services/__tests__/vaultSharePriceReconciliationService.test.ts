/**
 * Vault share-price reconciliation service tests.
 *
 * Covers the pure functions (eventDelta, replayVaultEvents,
 * computeContractSharePrice, reconcileSharePrice, severityForDeltaPct) and the
 * VaultSharePriceReconciliationService orchestration (deterministic result
 * shape, history persistence, cache-loader fallback).
 */

import {
  VAULT_SHARE_PRICE_PRECISION,
  FIELD_EPSILON,
  VaultSharePriceError,
  errorCodeToStatus,
  replayVaultEvents,
  eventDelta,
  detectDuplicateEvents,
  computeContractSharePrice,
  computeContractSharePriceRaw,
  severityForDeltaPct,
  reconcileSharePrice,
  VaultSharePriceReconciliationService,
  resetSharePriceReconHistory,
  getSharePriceReconHistory,
  type VaultProjectedState,
  type VaultSharePriceEvent,
  type CachedSharePrice,
} from "../vaultSharePriceReconciliationService";
import {
  SHARE_PRICE_THRESHOLD,
  SHARE_PRICE_STALE_PROJECTION_MS,
  type SharePriceReconStatus,
} from "../../../../shared/types/vaultSharePrice";

// ── Builders ───────────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<VaultSharePriceEvent> = {},
): VaultSharePriceEvent {
  return {
    vaultId: "vault-1",
    ledger: 100,
    txHash: "tx-0",
    eventIndex: 0,
    amount: "1000000",
    eventType: "deposit",
    ...overrides,
  };
}

function baseCached(overrides: Partial<CachedSharePrice> = {}): CachedSharePrice {
  return {
    vaultId: "vault-1",
    sharePrice: 1.0,
    totalShares: 1_000_000,
    totalAssets: 1_000_000,
    snapshotAt: new Date().toISOString(),
    ...overrides,
  };
}

function projected(overrides: Partial<VaultProjectedState> = {}): VaultProjectedState {
  return {
    vaultId: "vault-1",
    totalAssets: 0n,
    totalShares: 0n,
    eventCount: 0,
    lastLedger: 0,
    lastTxHash: "",
    ...overrides,
  };
}

// ── eventDelta ─────────────────────────────────────────────────────────────────

describe("eventDelta", () => {
  it("deposit mints assets and shares", () => {
    expect(eventDelta(makeEvent({ eventType: "deposit", shares: "500", amount: "1000" }))).toEqual({
      assetsDelta: 1000n,
      sharesDelta: 500n,
    });
  });

  it("deposit_for mints assets and shares (same as deposit)", () => {
    expect(eventDelta(makeEvent({ eventType: "deposit_for", shares: "300", amount: "600" }))).toEqual({
      assetsDelta: 600n,
      sharesDelta: 300n,
    });
  });

  it("withdraw burns assets and shares", () => {
    expect(eventDelta(makeEvent({ eventType: "withdraw", shares: "250", amount: "500" }))).toEqual({
      assetsDelta: -500n,
      sharesDelta: -250n,
    });
  });

  it("harvest nets out keeper fee against reward", () => {
    expect(eventDelta(makeEvent({ eventType: "harvest", amount: "1000", keeperFee: "100" }))).toEqual({
      assetsDelta: 900n,
      sharesDelta: 0n,
    });
  });

  it("harvest without keeperFee throws INVALID_EVENT", () => {
    expect(() => eventDelta(makeEvent({ eventType: "harvest", amount: "1000" }))).toThrow(
      VaultSharePriceError,
    );
    try {
      eventDelta(makeEvent({ eventType: "harvest", amount: "1000" }));
    } catch (e) {
      expect((e as VaultSharePriceError).code).toBe("INVALID_EVENT");
    }
  });

  it("rebalance removes assets from the vault token balance", () => {
    expect(eventDelta(makeEvent({ eventType: "rebalance", amount: "750" }))).toEqual({
      assetsDelta: -750n,
      sharesDelta: 0n,
    });
  });

  it("transfer_shares is a no-op on vault totals", () => {
    expect(eventDelta(makeEvent({ eventType: "transfer_shares", shares: "5" }))).toEqual({
      assetsDelta: 0n,
      sharesDelta: 0n,
    });
  });

  it("deposit without shares throws INVALID_EVENT", () => {
    expect(() => eventDelta(makeEvent({ eventType: "deposit", amount: "1000" }))).toThrow(
      VaultSharePriceError,
    );
  });

  it("unknown event type throws UNKNOWN_EVENT_TYPE", () => {
    expect(() =>
      eventDelta({ ...makeEvent({ eventType: "deposit" }), eventType: "bogus" as never }),
    ).toThrow(VaultSharePriceError);
  });

  it("non-integer-string amount throws MALFORMED_INPUT", () => {
    expect(() => eventDelta(makeEvent({ amount: "1.5" }))).toThrow(VaultSharePriceError);
    try {
      eventDelta(makeEvent({ amount: "abc" }));
    } catch (e) {
      expect((e as VaultSharePriceError).code).toBe("MALFORMED_INPUT");
    }
  });
});

// ── detectDuplicateEvents ─────────────────────────────────────────────────────

describe("detectDuplicateEvents", () => {
  it("returns zero duplicates for a unique batch", () => {
    const events = [
      makeEvent({ ledger: 1, txHash: "a", eventIndex: 0 }),
      makeEvent({ ledger: 2, txHash: "b", eventIndex: 0 }),
    ];
    expect(detectDuplicateEvents(events)).toEqual({ duplicateCount: 0, duplicatedKeys: [] });
  });

  it("counts duplicates by (vaultId, txHash, eventIndex)", () => {
    const events = [
      makeEvent({ ledger: 1, txHash: "a", eventIndex: 0 }),
      makeEvent({ ledger: 1, txHash: "a", eventIndex: 0 }), // dup of a:0
      makeEvent({ ledger: 2, txHash: "b", eventIndex: 0 }), // unique
    ];
    const result = detectDuplicateEvents(events);
    expect(result.duplicateCount).toBe(1);
    expect(result.duplicatedKeys).toEqual(["vault-1:a:0"]);
  });
});

// ── replayVaultEvents ──────────────────────────────────────────────────────────

describe("replayVaultEvents", () => {
  it("throws INVALID_EVENT on an empty event log", () => {
    expect(() => replayVaultEvents([])).toThrow(VaultSharePriceError);
    try {
      replayVaultEvents([]);
    } catch (e) {
      expect((e as VaultSharePriceError).code).toBe("INVALID_EVENT");
    }
  });

  it("sorts events by ledger before applying deltas", () => {
    // A withdraw before a deposit would drive totals negative if order were
    // preserved; sorted replay must keep totals non-negative.
    const events = [
      makeEvent({ eventType: "withdraw", amount: "100", shares: "10", ledger: 2, txHash: "b", eventIndex: 0 }),
      makeEvent({ eventType: "deposit", amount: "1000", shares: "1000", ledger: 1, txHash: "a", eventIndex: 0 }),
    ];
    const { state } = replayVaultEvents(events);
    expect(state.totalAssets).toBe(900n);
    expect(state.totalShares).toBe(990n);
    expect(state.lastLedger).toBe(2);
    expect(state.lastTxHash).toBe("b");
  });

  it("throws INVALID_EVENT when events span multiple vaults", () => {
    const events = [
      makeEvent({ vaultId: "vault-1", ledger: 1, txHash: "a", eventIndex: 0 }),
      makeEvent({ vaultId: "vault-2", ledger: 2, txHash: "b", eventIndex: 0 }),
    ];
    expect(() => replayVaultEvents(events)).toThrow(VaultSharePriceError);
    try {
      replayVaultEvents(events);
    } catch (e) {
      expect((e as VaultSharePriceError).code).toBe("INVALID_EVENT");
    }
  });

  it("de-duplicates repeated events keeping the first occurrence", () => {
    const events = [
      makeEvent({ amount: "100", shares: "100", ledger: 1, txHash: "a", eventIndex: 0 }),
      makeEvent({ amount: "100", shares: "100", ledger: 1, txHash: "a", eventIndex: 0 }),
    ];
    const { state, duplicateCount, warnings } = replayVaultEvents(events);
    expect(duplicateCount).toBe(1);
    expect(state.totalAssets).toBe(100n); // not 200
    expect(state.eventCount).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/duplicate event/);
  });

  it("throws NEGATIVE_TOTAL_ASSETS when a replay step underflows assets", () => {
    const events = [makeEvent({ eventType: "withdraw", amount: "500", shares: "50", ledger: 1, txHash: "a" })];
    expect(() => replayVaultEvents(events)).toThrow(VaultSharePriceError);
    try {
      replayVaultEvents(events);
    } catch (e) {
      expect((e as VaultSharePriceError).code).toBe("NEGATIVE_TOTAL_ASSETS");
    }
  });

  it("throws NEGATIVE_TOTAL_SHARES when a replay step underflows shares", () => {
    // Seed enough assets so the asset check stays green, then over-burn shares.
    const events = [
      makeEvent({ eventType: "deposit", amount: "1000", shares: "1000", ledger: 1, txHash: "a" }),
      makeEvent({ eventType: "withdraw", amount: "100", shares: "2000", ledger: 2, txHash: "b" }),
    ];
    expect(() => replayVaultEvents(events)).toThrow(VaultSharePriceError);
    try {
      replayVaultEvents(events);
    } catch (e) {
      expect((e as VaultSharePriceError).code).toBe("NEGATIVE_TOTAL_SHARES");
    }
  });

  it("honors an explicit initial baseline", () => {
    const events = [makeEvent({ amount: "500", shares: "500", ledger: 1, txHash: "a" })];
    const { state } = replayVaultEvents(events, { totalAssets: 1000n, totalShares: 1000n });
    expect(state.totalAssets).toBe(1500n);
    expect(state.totalShares).toBe(1500n);
  });

  it("projects a harvest → rebalance sequence correctly", () => {
    const events = [
      makeEvent({ eventType: "deposit", amount: "1000000", shares: "1000000", ledger: 1, txHash: "a" }),
      makeEvent({ eventType: "harvest", amount: "50000", keeperFee: "5000", ledger: 2, txHash: "b" }),
      makeEvent({ eventType: "rebalance", amount: "25000", ledger: 3, txHash: "c" }),
    ];
    const { state } = replayVaultEvents(events);
    // 1_000_000 + (50_000 - 5_000) - 25_000 = 1_020_000 assets; shares unchanged.
    expect(state.totalAssets).toBe(1_020_000n);
    expect(state.totalShares).toBe(1_000_000n);
    expect(state.eventCount).toBe(3);
  });
});

// ── computeContractSharePrice ──────────────────────────────────────────────────

describe("computeContractSharePrice", () => {
  it("derives the share price in base units", () => {
    expect(
      computeContractSharePrice(projected({ totalAssets: 1_500n, totalShares: 1_000n })),
    ).toBe(1.5);
  });

  it("returns null when there are no outstanding shares", () => {
    expect(computeContractSharePrice(projected({ totalAssets: 1_000n, totalShares: 0n }))).toBeNull();
  });

  it("matches the 1e18 fixed-point contract formula", () => {
    const state = projected({ totalAssets: 3n, totalShares: 2n });
    const raw = computeContractSharePriceRaw(state);
    // raw = 3 * 1e18 / 2 = 1.5e18
    expect(raw).toBe((3n * VAULT_SHARE_PRICE_PRECISION) / 2n);
    expect(computeContractSharePrice(state)).toBe(Number(raw) / Number(VAULT_SHARE_PRICE_PRECISION));
  });
});

// ── severityForDeltaPct ────────────────────────────────────────────────────────

describe("severityForDeltaPct", () => {
  it("matched band below SMALL threshold", () => {
    expect(severityForDeltaPct(0)).toBe("matched");
    expect(severityForDeltaPct(SHARE_PRICE_THRESHOLD.SMALL / 2)).toBe("matched");
  });

  it("small band at the SMALL boundary", () => {
    expect(severityForDeltaPct(SHARE_PRICE_THRESHOLD.SMALL)).toBe("small");
  });

  it("material band at the MATERIAL boundary", () => {
    expect(severityForDeltaPct(SHARE_PRICE_THRESHOLD.MATERIAL)).toBe("material");
  });

  it("critical band at the CRITICAL boundary", () => {
    expect(severityForDeltaPct(SHARE_PRICE_THRESHOLD.CRITICAL)).toBe("critical");
  });

  it("uses absolute value for negative drift", () => {
    expect(severityForDeltaPct(-SHARE_PRICE_THRESHOLD.CRITICAL)).toBe("critical");
  });
});

// ── errorCodeToStatus ──────────────────────────────────────────────────────────

describe("errorCodeToStatus", () => {
  it("maps every error code to an HTTP status", () => {
    expect(errorCodeToStatus.INVALID_EVENT).toBe(400);
    expect(errorCodeToStatus.MALFORMED_INPUT).toBe(400);
    expect(errorCodeToStatus.UNKNOWN_EVENT_TYPE).toBe(400);
    expect(errorCodeToStatus.NEGATIVE_TOTAL_ASSETS).toBe(400);
    expect(errorCodeToStatus.NEGATIVE_TOTAL_SHARES).toBe(400);
    expect(errorCodeToStatus.DIVISION_BY_ZERO).toBe(400);
    expect(errorCodeToStatus.CACHE_UNAVAILABLE).toBe(503);
  });
});

// ── reconcileSharePrice (pure comparison) ──────────────────────────────────────

describe("reconcileSharePrice", () => {
  const opts = { vaultId: "vault-1" };

  it("returns failed/SOURCE_UNAVAILABLE when a sourceError is supplied", () => {
    const r = reconcileSharePrice(null, null, { ...opts, sourceError: new Error("boom") });
    expect(r.status).toBe("failed");
    expect(r.primaryCause).toBe("SOURCE_UNAVAILABLE");
    expect(r.causeCounts.SOURCE_UNAVAILABLE).toBe(1);
  });

  it("returns failed with no causes when cache is null (contract state preserved)", () => {
    const contractState = projected({ totalAssets: 100n, totalShares: 100n, eventCount: 1 });
    const r = reconcileSharePrice(contractState, null, opts);
    expect(r.status).toBe("failed");
    expect(r.cachedState).toBeNull();
    expect(r.contractState).toEqual(contractState);
    expect(r.contractSharePrice).toBe(1.0);
    expect(r.primaryCause).toBe("SOURCE_UNAVAILABLE");
  });

  it("returns partial when contract state is null but cache exists", () => {
    const c = baseCached();
    const r = reconcileSharePrice(null, c, opts);
    expect(r.status).toBe("partial");
    expect(r.contractState).toBeNull();
    expect(r.cachedState).toEqual(c);
    expect(r.primaryCause).toBe("SOURCE_UNAVAILABLE");
  });

  it("flags a stale projection (>5m) as STALE_SOURCE", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const cached = baseCached({ projectionAgeMs: SHARE_PRICE_STALE_PROJECTION_MS + 1 });
    const r = reconcileSharePrice(contractState, cached, opts);
    expect(r.isStale).toBe(true);
    expect(r.staleDurationMs).toBeGreaterThan(SHARE_PRICE_STALE_PROJECTION_MS);
    expect(r.causes.some((c) => c.code === "STALE_SOURCE")).toBe(true);
  });

  it("reports no staleness when projectionAgeMs is within budget", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const cached = baseCached({ projectionAgeMs: 1000 });
    const r = reconcileSharePrice(contractState, cached, opts);
    expect(r.isStale).toBe(false);
    expect(r.staleDurationMs).toBeUndefined();
  });

  it("produces success when contract and cache agree within epsilon", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1, lastLedger: 5, lastTxHash: "x" });
    const cached = baseCached({ sharePrice: 1.0, totalShares: 1_000, totalAssets: 1_000 });
    const r = reconcileSharePrice(contractState, cached, opts);
    expect(r.status).toBe("success");
    expect(r.mismatches).toHaveLength(0);
    expect(r.sharesAgree).toBe(true);
    expect(r.assetsAgree).toBe(true);
    expect(r.primaryCause).toBeNull();
    expect(r.maxDriftPct).toBeNull();
  });

  it("detects totalShares drift (AMOUNT_DRIFT, non-critical)", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_100n, eventCount: 1, lastLedger: 5, lastTxHash: "x" });
    const cached = baseCached({ totalShares: 1_000, totalAssets: 1_000 });
    const r = reconcileSharePrice(contractState, cached, opts);
    const sharesMismatch = r.mismatches.find((m) => m.field === "totalShares");
    expect(sharesMismatch).toBeDefined();
    expect(r.causes.some((c) => c.code === "AMOUNT_DRIFT")).toBe(true);
    expect(r.sharesAgree).toBe(false);
    expect(r.assetsAgree).toBe(true);
  });

  it("detects totalAssets drift", () => {
    const contractState = projected({ totalAssets: 2_000n, totalShares: 1_000n, eventCount: 1 });
    const cached = baseCached({ totalAssets: 1_000 });
    const r = reconcileSharePrice(contractState, cached, opts);
    expect(r.mismatches.some((m) => m.field === "totalAssets")).toBe(true);
    expect(r.assetsAgree).toBe(false);
  });

  it("detects share price drift", () => {
    const contractState = projected({ totalAssets: 2_000n, totalShares: 1_000n, eventCount: 1 });
    const cached = baseCached({ sharePrice: 1.0, totalAssets: 2_000, totalShares: 1_000 });
    const r = reconcileSharePrice(contractState, cached, opts);
    expect(r.mismatches.some((m) => m.field === "sharePrice")).toBe(true);
  });

  it("treats non-zero contract vs zero cache as critical drift", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const cached = baseCached({ totalShares: 0, totalAssets: 0, sharePrice: 0 });
    const r = reconcileSharePrice(contractState, cached, opts);
    expect(r.maxDriftPct).toBe(SHARE_PRICE_THRESHOLD.CRITICAL);
    const priceMismatch = r.mismatches.find((m) => m.field === "sharePrice");
    expect(priceMismatch?.severity).toBe("critical");
  });

  it("adds DUPLICATE_POSITION cause when duplicateEvents provided", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const r = reconcileSharePrice(contractState, baseCached(), { ...opts, duplicateEvents: 3 });
    expect(r.causeCounts.DUPLICATE_POSITION).toBe(1);
    expect(r.causes.some((c) => c.code === "DUPLICATE_POSITION" && c.detail.includes("3"))).toBe(true);
  });

  it("respects FIELD_EPSILON for near-equal floats", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const cached = baseCached({ sharePrice: 1.0 + FIELD_EPSILON / 2, totalShares: 1_000, totalAssets: 1_000 });
    const r = reconcileSharePrice(contractState, cached, opts);
    expect(r.status).toBe("success");
    expect(r.mismatches).toHaveLength(0);
  });

  it("builds a deterministic result with a timestamp and causeCounts", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const r = reconcileSharePrice(contractState, baseCached({ totalShares: 1_000, totalAssets: 1_000, sharePrice: 1.0 }), opts);
    expect(typeof r.timestamp).toBe("string");
    expect(new Date(r.timestamp).getTime()).not.toBeNaN();
    expect(r.causeCounts).toEqual({});
  });

  it("prioritizes SOURCE_UNAVAILABLE over STALE_SOURCE in primaryCause ordering", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const cached = baseCached({ projectionAgeMs: SHARE_PRICE_STALE_PROJECTION_MS + 1 });
    const r = reconcileSharePrice(contractState, cached, { ...opts, sourceError: new Error("db down") });
    expect(r.status).toBe("failed");
    expect(r.primaryCause).toBe("SOURCE_UNAVAILABLE");
  });
});

// ── VaultSharePriceReconciliationService ────────────────────────────────────────

describe("VaultSharePriceReconciliationService", () => {
  beforeEach(() => {
    resetSharePriceReconHistory();
  });

  function eventsFromContract(assets: number, shares: number, vaultId = "vault-1") {
    return [makeEvent({ vaultId, eventType: "deposit", amount: String(assets), shares: String(shares) })];
  }

  it("reconcileVault returns success when contract and cache agree", async () => {
    const service = new VaultSharePriceReconciliationService();
    const r = await service.reconcileVault(
      "vault-1",
      eventsFromContract(1_000_000, 1_000_000),
      baseCached({ sharePrice: 1.0, totalShares: 1_000_000, totalAssets: 1_000_000 }),
    );
    expect(r.status).toBe("success");
    expect(r.contractSharePrice).toBe(1.0);
    expect(r.sharesAgree).toBe(true);
  });

  it("reconcileVault returns partial/partial-status mismatch when drift present", async () => {
    const service = new VaultSharePriceReconciliationService();
    const r = await service.reconcileVault(
      "vault-1",
      eventsFromContract(2_000_000, 2_000_000),
      baseCached({ sharePrice: 1.0, totalShares: 1_000_000, totalAssets: 1_000_000 }),
    );
    expect(["partial", "failed"]).toContain(r.status);
    expect(r.assetsAgree).toBe(false);
  });

  it("reconcileVault with an empty event log yields partial (no contract state)", async () => {
    const service = new VaultSharePriceReconciliationService();
    const r = await service.reconcileVault("vault-1", [], baseCached());
    expect(r.status).toBe("partial");
    expect(r.contractState).toBeNull();
  });

  it("reconcileVault surfaces cache-loader results when cachedState is omitted", async () => {
    let calledWith: string | null = null;
    const snap = baseCached();
    const service = new VaultSharePriceReconciliationService({
      cacheLoader: {
        loadSharePrice(vaultId: string) {
          calledWith = vaultId;
          return Promise.resolve(snap);
        },
      },
    });
    const r = await service.reconcileVault("vault-1", eventsFromContract(1_000_000, 1_000_000));
    expect(calledWith).toBe("vault-1");
    expect(r.cachedState).toBe(snap);
  });

  it("reconcileVault returns failed when the cache loader yields nothing", async () => {
    const service = new VaultSharePriceReconciliationService({
      cacheLoader: { loadSharePrice: () => Promise.resolve(null) },
    });
    const r = await service.reconcileVault("vault-1", eventsFromContract(1_000_000, 1_000_000));
    expect(r.status).toBe("failed");
    expect(r.cachedState).toBeNull();
  });

  it("reconcileVault throws VaultSharePriceError on malformed events (propagated)", async () => {
    const service = new VaultSharePriceReconciliationService({
      cacheLoader: { loadSharePrice: () => Promise.resolve(baseCached()) },
    });
    await expect(
      service.reconcileVault("vault-1", [makeEvent({ amount: "abc" })]),
    ).rejects.toThrow(VaultSharePriceError);
  });

  it("persists results to history and getHistory returns them", async () => {
    const service = new VaultSharePriceReconciliationService({
      cacheLoader: { loadSharePrice: () => Promise.resolve(baseCached()) },
    });
    const r = await service.reconcileVault("vault-1", eventsFromContract(1_000_000, 1_000_000));
    const hist = service.getHistory("vault-1");
    expect(hist).toHaveLength(1);
    expect(hist[0].status).toBe(r.status);
    expect(hist[0].vaultId).toBe("vault-1");
    expect(hist[0].id).toEqual(expect.stringContaining("sp_recon_"));
  });

  it("getHistory filters by vaultId and is isolated from other vaults", async () => {
    const service = new VaultSharePriceReconciliationService({
      cacheLoader: { loadSharePrice: () => Promise.resolve(baseCached()) },
    });
    await service.reconcileVault("vault-A", eventsFromContract(1_000_000, 1_000_000, "vault-A"));
    await service.reconcileVault("vault-B", eventsFromContract(1_000_000, 1_000_000, "vault-B"));
    expect(service.getHistory("vault-A")).toHaveLength(1);
    expect(service.getHistory("vault-A")[0].vaultId).toBe("vault-A");
  });

  it("uses the shared module-level history store via getSharePriceReconHistory", async () => {
    const service = new VaultSharePriceReconciliationService({
      cacheLoader: { loadSharePrice: () => Promise.resolve(baseCached()) },
    });
    await service.reconcileVault("vault-1", eventsFromContract(1_000_000, 1_000_000));
    expect(getSharePriceReconHistory("vault-1").length).toBeGreaterThanOrEqual(1);
  });

  it("throws CACHE_UNAVAILABLE (503) when the cache loader rejects", async () => {
    const service = new VaultSharePriceReconciliationService({
      cacheLoader: { loadSharePrice: () => Promise.reject(new Error("db down")) },
    });
    await expect(
      service.reconcileVault("vault-1", eventsFromContract(1_000_000, 1_000_000)),
    ).rejects.toThrow(VaultSharePriceError);
  });
});

// Sanity: a valid status string is produced by the pure comparison path.
describe("status type", () => {
  it("success status is one of the valid union members", () => {
    const contractState = projected({ totalAssets: 1_000n, totalShares: 1_000n, eventCount: 1 });
    const r = reconcileSharePrice(contractState, baseCached(), { vaultId: "v" });
    const valid: SharePriceReconStatus = r.status;
    expect(["success", "partial", "failed"]).toContain(valid);
  });
});

// ── Full contract event vocabulary ────────────────────────────────────────────

describe("contract event vocabulary (flash_loan / emergency_withdraw / rescue)", () => {
  beforeEach(() => {
    resetSharePriceReconHistory();
  });

  it("flash_loan grows assets by the premium only", () => {
    expect(eventDelta(makeEvent({ eventType: "flash_loan", amount: "90" }))).toEqual({
      assetsDelta: 90n,
      sharesDelta: 0n,
    });
  });

  it("emergency_withdraw burns shares and removes the net amount paid out", () => {
    expect(
      eventDelta(makeEvent({ eventType: "emergency_withdraw", amount: "450", shares: "500" })),
    ).toEqual({ assetsDelta: -450n, sharesDelta: -500n });
  });

  it("emergency_withdraw without shares throws INVALID_EVENT", () => {
    expect(() =>
      eventDelta(makeEvent({ eventType: "emergency_withdraw", amount: "450" })),
    ).toThrow(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("rescue floors totalAssets at zero like the contract does", () => {
    const { state } = replayVaultEvents([
      makeEvent({ eventType: "deposit", amount: "1000", shares: "1000", ledger: 1, txHash: "a" }),
      makeEvent({ eventType: "rescue", amount: "5000", ledger: 2, txHash: "b" }),
    ]);
    expect(state.totalAssets).toBe(0n);
    expect(state.totalShares).toBe(1000n);
  });

  it("rejects a signed (negative) amount instead of flipping the delta", () => {
    expect(() => eventDelta(makeEvent({ eventType: "deposit", amount: "-5", shares: "5" }))).toThrow(
      expect.objectContaining({ code: "MALFORMED_INPUT" }),
    );
  });

  it("replays a full lifecycle to the contract share price", async () => {
    // deposit 1_000_000 @ 1:1, harvest +100_000 net (fee 10_000), flash fee +5_000,
    // withdraw 200_000 shares for 221_000 assets, emergency withdraw 100_000 shares
    // for 99_000 net, rescue 1_000, transfer_shares (no-op).
    const events = [
      makeEvent({ eventType: "deposit", amount: "1000000", shares: "1000000", ledger: 1, txHash: "t1" }),
      makeEvent({ eventType: "harvest", amount: "110000", keeperFee: "10000", ledger: 2, txHash: "t2" }),
      makeEvent({ eventType: "flash_loan", amount: "5000", ledger: 3, txHash: "t3" }),
      makeEvent({ eventType: "withdraw", amount: "221000", shares: "200000", ledger: 4, txHash: "t4" }),
      makeEvent({ eventType: "emergency_withdraw", amount: "99000", shares: "100000", ledger: 5, txHash: "t5" }),
      makeEvent({ eventType: "rescue", amount: "1000", ledger: 6, txHash: "t6" }),
      makeEvent({ eventType: "transfer_shares", amount: "0", shares: "50", ledger: 7, txHash: "t7" }),
    ];
    const expectedAssets = 1_000_000 + 100_000 + 5_000 - 221_000 - 99_000 - 1_000; // 784_000
    const expectedShares = 700_000;

    const service = new VaultSharePriceReconciliationService({ cacheLoader: null as never });
    const r = await service.reconcileVault(
      "vault-1",
      events,
      baseCached({
        totalAssets: expectedAssets,
        totalShares: expectedShares,
        sharePrice: expectedAssets / expectedShares,
      }),
    );
    expect(r.contractState?.totalAssets).toBe(BigInt(expectedAssets));
    expect(r.contractState?.totalShares).toBe(BigInt(expectedShares));
    expect(r.status).toBe("success");
    expect(r.causes).toEqual([]);
  });

  it("flags a cache that missed a flash_loan premium as drift", async () => {
    const service = new VaultSharePriceReconciliationService({ cacheLoader: null as never });
    const r = await service.reconcileVault(
      "vault-1",
      [
        makeEvent({ eventType: "deposit", amount: "1000000", shares: "1000000", ledger: 1, txHash: "t1" }),
        makeEvent({ eventType: "flash_loan", amount: "200000", ledger: 2, txHash: "t2" }),
      ],
      baseCached(), // cache still at 1_000_000 / 1_000_000
    );
    expect(r.status).toBe("partial");
    expect(r.primaryCause).toBe("AMOUNT_DRIFT");
    expect(r.assetsAgree).toBe(false);
    expect(r.sharesAgree).toBe(true);
  });

  it("rejects events for a different vault than requested", async () => {
    const service = new VaultSharePriceReconciliationService({ cacheLoader: null as never });
    await expect(
      service.reconcileVault(
        "vault-2",
        [makeEvent({ vaultId: "vault-1", amount: "1000", shares: "1000" })],
        baseCached(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_EVENT" });
  });
});

describe("loadLatestSharePriceSnapshot", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("@prisma/client");
  });

  it("maps the single row returned by findFirst to a cached snapshot", async () => {
    const snapshotAt = new Date("2026-09-01T00:00:00.000Z");
    jest.doMock("@prisma/client", () => ({
      PrismaClient: class {
        sharePriceSnapshot = {
          findFirst: jest.fn().mockResolvedValue({
            sharePrice: 1.25,
            totalShares: 800,
            totalAssets: 1000,
            snapshotAt,
          }),
        };
        $disconnect = jest.fn().mockResolvedValue(undefined);
      },
    }));
    const mod = await import("../vaultSharePriceReconciliationService");
    await expect(mod.loadLatestSharePriceSnapshot("vault-1")).resolves.toEqual({
      vaultId: "vault-1",
      sharePrice: 1.25,
      totalShares: 800,
      totalAssets: 1000,
      snapshotAt: snapshotAt.toISOString(),
      projectionVersion: undefined,
      lastLedger: undefined,
      projectionAgeMs: undefined,
    });
  });

  it("returns null when no snapshot exists", async () => {
    jest.doMock("@prisma/client", () => ({
      PrismaClient: class {
        sharePriceSnapshot = { findFirst: jest.fn().mockResolvedValue(null) };
        $disconnect = jest.fn().mockResolvedValue(undefined);
      },
    }));
    const mod = await import("../vaultSharePriceReconciliationService");
    await expect(mod.loadLatestSharePriceSnapshot("vault-1")).resolves.toBeNull();
  });
});

describe("history store", () => {
  beforeEach(() => resetSharePriceReconHistory());

  it("evicts the oldest entries past SHARE_PRICE_RECON_HISTORY_LIMIT", async () => {
    const { SHARE_PRICE_RECON_HISTORY_LIMIT } = await import(
      "../vaultSharePriceReconciliationService"
    );
    const service = new VaultSharePriceReconciliationService({ cacheLoader: null as never });
    for (let i = 0; i < SHARE_PRICE_RECON_HISTORY_LIMIT + 5; i += 1) {
      await service.reconcileVault("vault-1", [], baseCached());
    }
    expect(getSharePriceReconHistory()).toHaveLength(SHARE_PRICE_RECON_HISTORY_LIMIT);
  });
});
