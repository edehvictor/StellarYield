import {
  compareTimelineKeysDesc,
  decodeTimelineCursor,
  encodeTimelineCursor,
  isBeforeTimelineCursor,
  parsePaginationLimit,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  type TimelineCursor,
} from "../types/pagination";

describe("encodeTimelineCursor / decodeTimelineCursor", () => {
  it("round-trips a (ts, id) pair", () => {
    const cursor: TimelineCursor = { ts: 1_725_000_000_000, id: "abc-123" };
    const encoded = encodeTimelineCursor(cursor);
    expect(decodeTimelineCursor(encoded)).toEqual(cursor);
  });

  it("produces an opaque, URL-safe token", () => {
    const encoded = encodeTimelineCursor({ ts: 1_725_000_000_000, id: "abc-123" });
    expect(encoded).not.toContain(":");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips ids that themselves contain a colon", () => {
    const cursor: TimelineCursor = { ts: 42, id: "uuid:with:colons" };
    expect(decodeTimelineCursor(encodeTimelineCursor(cursor))).toEqual(cursor);
  });

  it("returns null for an undefined, null, or empty cursor", () => {
    expect(decodeTimelineCursor(undefined)).toBeNull();
    expect(decodeTimelineCursor(null)).toBeNull();
    expect(decodeTimelineCursor("")).toBeNull();
  });

  it("returns null for a malformed cursor instead of throwing", () => {
    expect(() => decodeTimelineCursor("not-a-real-cursor")).not.toThrow();
    expect(decodeTimelineCursor("not-a-real-cursor")).toBeNull();
    expect(decodeTimelineCursor("!!!not-base64!!!")).toBeNull();
  });
});

describe("isBeforeTimelineCursor", () => {
  it("is true for an older timestamp", () => {
    const cursor: TimelineCursor = { ts: 1000, id: "b" };
    expect(isBeforeTimelineCursor({ ts: 500, id: "z" }, cursor)).toBe(true);
  });

  it("is false for a newer timestamp", () => {
    const cursor: TimelineCursor = { ts: 1000, id: "b" };
    expect(isBeforeTimelineCursor({ ts: 1500, id: "a" }, cursor)).toBe(false);
  });

  it("uses id as a tie-breaker when timestamps are equal", () => {
    const cursor: TimelineCursor = { ts: 1000, id: "m" };
    expect(isBeforeTimelineCursor({ ts: 1000, id: "a" }, cursor)).toBe(true);
    expect(isBeforeTimelineCursor({ ts: 1000, id: "z" }, cursor)).toBe(false);
  });

  it("is false when the key equals the cursor exactly", () => {
    const cursor: TimelineCursor = { ts: 1000, id: "m" };
    expect(isBeforeTimelineCursor({ ts: 1000, id: "m" }, cursor)).toBe(false);
  });
});

describe("compareTimelineKeysDesc", () => {
  it("sorts newer timestamps first", () => {
    const keys: TimelineCursor[] = [
      { ts: 100, id: "a" },
      { ts: 300, id: "b" },
      { ts: 200, id: "c" },
    ];
    const sorted = [...keys].sort(compareTimelineKeysDesc);
    expect(sorted.map((k) => k.ts)).toEqual([300, 200, 100]);
  });

  it("breaks ties on id (descending) when timestamps match", () => {
    const keys: TimelineCursor[] = [
      { ts: 100, id: "a" },
      { ts: 100, id: "c" },
      { ts: 100, id: "b" },
    ];
    const sorted = [...keys].sort(compareTimelineKeysDesc);
    expect(sorted.map((k) => k.id)).toEqual(["c", "b", "a"]);
  });

  it("returns 0 for identical keys", () => {
    expect(compareTimelineKeysDesc({ ts: 1, id: "x" }, { ts: 1, id: "x" })).toBe(0);
  });
});

describe("parsePaginationLimit", () => {
  it("returns the default limit when unset", () => {
    expect(parsePaginationLimit(undefined)).toBe(PAGINATION_DEFAULT_LIMIT);
  });

  it("clamps to the max limit", () => {
    expect(parsePaginationLimit(PAGINATION_MAX_LIMIT + 500)).toBe(PAGINATION_MAX_LIMIT);
  });

  it("returns the default for invalid input", () => {
    expect(parsePaginationLimit("not-a-number")).toBe(PAGINATION_DEFAULT_LIMIT);
    expect(parsePaginationLimit(-5)).toBe(PAGINATION_DEFAULT_LIMIT);
  });

  it("floors fractional values", () => {
    expect(parsePaginationLimit(10.9)).toBe(10);
  });
});