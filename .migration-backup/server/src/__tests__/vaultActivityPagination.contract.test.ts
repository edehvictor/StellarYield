import {
  encodeCursor,
  decodeCursor,
  CursorDecodeError,
  compareEvents,
  applyFilters,
  paginateVaultActivity,
  type VaultActivityEvent,
  type VaultActivityCursor,
  type VaultActivityFilters,
} from "../routes/vaultActivity";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<VaultActivityEvent> & Pick<VaultActivityEvent, "ledger" | "txHash" | "eventIndex">): VaultActivityEvent {
  return {
    id: `${overrides.ledger}-${overrides.txHash.slice(0, 8)}-${overrides.eventIndex}`,
    vaultId: "vault-A",
    asset: "USDC",
    eventType: "deposit",
    amount: "1000000",
    wallet: "GAAAA",
    timestamp: new Date(Date.UTC(2024, 0, overrides.ledger % 28 || 1)).toISOString(),
    ...overrides,
  };
}

const TX_A = "a".repeat(64);
const TX_B = "b".repeat(64);
const TX_C = "c".repeat(64);
const TX_D = "d".repeat(64);

const BASE_EVENTS: VaultActivityEvent[] = [
  makeEvent({ ledger: 100, txHash: TX_A, eventIndex: 0, vaultId: "vault-A", asset: "USDC", eventType: "deposit" }),
  makeEvent({ ledger: 100, txHash: TX_A, eventIndex: 1, vaultId: "vault-A", asset: "USDC", eventType: "reward" }),
  makeEvent({ ledger: 100, txHash: TX_B, eventIndex: 0, vaultId: "vault-B", asset: "XLM", eventType: "withdrawal" }),
  makeEvent({ ledger: 101, txHash: TX_C, eventIndex: 0, vaultId: "vault-A", asset: "USDC", eventType: "rebalance" }),
  makeEvent({ ledger: 102, txHash: TX_D, eventIndex: 0, vaultId: "vault-A", asset: "XLM", eventType: "deposit" }),
  makeEvent({ ledger: 103, txHash: TX_A, eventIndex: 0, vaultId: "vault-B", asset: "USDC", eventType: "reward" }),
];

// ── Cursor encoding/decoding ───────────────────────────────────────────────

describe("cursor encoding / decoding", () => {
  test("round-trips a valid cursor", () => {
    const cursor: VaultActivityCursor = { ledger: 999, txHash: TX_A, eventIndex: 7 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test("round-trips ledger=0 and eventIndex=0", () => {
    const cursor: VaultActivityCursor = { ledger: 0, txHash: TX_B, eventIndex: 0 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  test("throws CursorDecodeError for random garbage string", () => {
    expect(() => decodeCursor("not-a-cursor!!")).toThrow(CursorDecodeError);
  });

  test("throws CursorDecodeError for base64-encoded wrong field count", () => {
    const bad = Buffer.from("100:abc", "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(CursorDecodeError);
  });

  test("throws CursorDecodeError for negative ledger", () => {
    const bad = Buffer.from(`-1:${TX_A}:0`, "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(CursorDecodeError);
  });

  test("throws CursorDecodeError for non-hex txHash", () => {
    const bad = Buffer.from(`100:not-a-hash:0`, "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(CursorDecodeError);
  });

  test("throws CursorDecodeError for txHash with wrong length", () => {
    const bad = Buffer.from(`100:${TX_A.slice(0, 32)}:0`, "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(CursorDecodeError);
  });

  test("throws CursorDecodeError for empty string", () => {
    expect(() => decodeCursor("")).toThrow(CursorDecodeError);
  });

  test("throws CursorDecodeError for extra colon segment", () => {
    const bad = Buffer.from(`100:${TX_A}:0:extra`, "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(CursorDecodeError);
  });
});

// ── Stable sort order ──────────────────────────────────────────────────────

describe("compareEvents stable sort", () => {
  test("sorts by ledger ascending", () => {
    const a = makeEvent({ ledger: 1, txHash: TX_A, eventIndex: 0 });
    const b = makeEvent({ ledger: 2, txHash: TX_A, eventIndex: 0 });
    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(b, a)).toBeGreaterThan(0);
  });

  test("sorts by txHash when ledgers are equal", () => {
    const a = makeEvent({ ledger: 5, txHash: TX_A, eventIndex: 0 });
    const b = makeEvent({ ledger: 5, txHash: TX_B, eventIndex: 0 });
    expect(compareEvents(a, b)).toBeLessThan(0);
  });

  test("sorts by eventIndex when ledger and txHash are equal", () => {
    const a = makeEvent({ ledger: 5, txHash: TX_A, eventIndex: 0 });
    const b = makeEvent({ ledger: 5, txHash: TX_A, eventIndex: 1 });
    expect(compareEvents(a, b)).toBeLessThan(0);
  });

  test("returns 0 for identical sort keys", () => {
    const a = makeEvent({ ledger: 5, txHash: TX_A, eventIndex: 3 });
    const b = makeEvent({ ledger: 5, txHash: TX_A, eventIndex: 3 });
    expect(compareEvents(a, b)).toBe(0);
  });

  test("sort is idempotent when applied twice", () => {
    const events = [...BASE_EVENTS];
    const once = [...events].sort(compareEvents);
    const twice = [...once].sort(compareEvents);
    expect(twice.map((e) => e.id)).toEqual(once.map((e) => e.id));
  });
});

// ── Filter application ─────────────────────────────────────────────────────

describe("applyFilters", () => {
  test("filters by vaultId", () => {
    const result = applyFilters(BASE_EVENTS, { vaultId: "vault-B" });
    expect(result.every((e) => e.vaultId === "vault-B")).toBe(true);
    expect(result.length).toBe(2);
  });

  test("filters by asset", () => {
    const result = applyFilters(BASE_EVENTS, { asset: "XLM" });
    expect(result.every((e) => e.asset === "XLM")).toBe(true);
  });

  test("filters by eventType", () => {
    const result = applyFilters(BASE_EVENTS, { eventType: "reward" });
    expect(result.every((e) => e.eventType === "reward")).toBe(true);
    expect(result.length).toBe(2);
  });

  test("filters by ledgerFrom", () => {
    const result = applyFilters(BASE_EVENTS, { ledgerFrom: 102 });
    expect(result.every((e) => e.ledger >= 102)).toBe(true);
  });

  test("filters by ledgerTo", () => {
    const result = applyFilters(BASE_EVENTS, { ledgerTo: 100 });
    expect(result.every((e) => e.ledger <= 100)).toBe(true);
  });

  test("filters by ledger window (from + to)", () => {
    const result = applyFilters(BASE_EVENTS, { ledgerFrom: 101, ledgerTo: 102 });
    expect(result.every((e) => e.ledger >= 101 && e.ledger <= 102)).toBe(true);
    expect(result.length).toBe(2);
  });

  test("combines vaultId + eventType filters", () => {
    const result = applyFilters(BASE_EVENTS, { vaultId: "vault-A", eventType: "deposit" });
    expect(result.every((e) => e.vaultId === "vault-A" && e.eventType === "deposit")).toBe(true);
  });

  test("returns empty array when no events match", () => {
    const result = applyFilters(BASE_EVENTS, { vaultId: "vault-UNKNOWN" });
    expect(result).toHaveLength(0);
  });

  test("returns all events when no filters provided", () => {
    const result = applyFilters(BASE_EVENTS, {});
    expect(result).toHaveLength(BASE_EVENTS.length);
  });
});

// ── Pagination ────────────────────────────────────────────────────────────

describe("paginateVaultActivity", () => {
  function makeSet(count: number): VaultActivityEvent[] {
    return Array.from({ length: count }, (_, i) =>
      makeEvent({ ledger: i + 1, txHash: TX_A, eventIndex: 0, vaultId: "vault-A" }),
    );
  }

  test("first page returns up to pageSize events", () => {
    const events = makeSet(10);
    const page = paginateVaultActivity({ events, filters: {}, pageSize: 4 });
    expect(page.events).toHaveLength(4);
    expect(page.nextCursor).not.toBeNull();
    expect(page.prevCursor).toBeNull();
    expect(page.total).toBe(10);
  });

  test("last page has null nextCursor", () => {
    const events = makeSet(5);
    const page = paginateVaultActivity({ events, filters: {}, pageSize: 10 });
    expect(page.events).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  test("cursor-forward walk covers all events without duplicates", () => {
    const events = makeSet(9);
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page = paginateVaultActivity({
        events,
        filters: {},
        afterCursor: cursor ? decodeCursor(cursor) : undefined,
        pageSize: 3,
      });
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  test("cursor stability under inserted records", () => {
    const events = makeSet(6);
    const firstPage = paginateVaultActivity({ events, filters: {}, pageSize: 3 });
    const firstPageIds = firstPage.events.map((e) => e.id);

    // Insert a new event in the middle (ledger 99 sorts before ledger 1? no — before sort key 1)
    // Insert between ledger 3 and 4 at ledger 3.5 — but since ledger is int,
    // we insert a second event at ledger 3 with a different txHash that sorts after TX_A
    const inserted = makeEvent({ ledger: 3, txHash: TX_B, eventIndex: 0, vaultId: "vault-A" });
    const augmented = [...events, inserted];

    // Re-fetch first page — it must contain the same events since they're before cursor
    const rePage = paginateVaultActivity({ events: augmented, filters: {}, pageSize: 3 });
    expect(rePage.events.map((e) => e.id)).toEqual(firstPageIds);

    // Continue from the saved cursor — inserted event (ledger=3, TX_B) appears on page 2
    const secondPage = paginateVaultActivity({
      events: augmented,
      filters: {},
      afterCursor: decodeCursor(firstPage.nextCursor!),
      pageSize: 3,
    });
    // The inserted event sorts at position 4 (ledger 3, TX_B > TX_A), so it appears on p2
    expect(secondPage.events.some((e) => e.id === inserted.id)).toBe(true);
  });

  test("empty result when all events filtered out", () => {
    const events = makeSet(5);
    const page = paginateVaultActivity({ events, filters: { vaultId: "vault-NONE" }, pageSize: 10 });
    expect(page.events).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(0);
  });

  test("pageSize is capped at MAX_PAGE_SIZE (via route), pagination works for large sets", () => {
    const events = makeSet(150);
    const page = paginateVaultActivity({ events, filters: {}, pageSize: 100 });
    expect(page.events).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();
  });

  test("before-cursor returns correct slice", () => {
    const events = makeSet(6);
    const allPage = paginateVaultActivity({ events, filters: {}, pageSize: 6 });
    const thirdEventCursor: VaultActivityCursor = {
      ledger: allPage.events[2].ledger,
      txHash: allPage.events[2].txHash,
      eventIndex: allPage.events[2].eventIndex,
    };

    const before = paginateVaultActivity({
      events,
      filters: {},
      beforeCursor: thirdEventCursor,
      pageSize: 10,
    });
    expect(before.events.every((e) => e.ledger < thirdEventCursor.ledger || (
      e.ledger === thirdEventCursor.ledger && e.txHash === thirdEventCursor.txHash && e.eventIndex < thirdEventCursor.eventIndex
    ))).toBe(true);
  });
});
