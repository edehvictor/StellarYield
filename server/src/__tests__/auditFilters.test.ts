/**
 * Unit tests for audit-log filter parsing (#1406).
 */

import {
  AUDIT_MAX_ACTION_FILTERS,
  auditEntryInvolvesWallet,
  parseAuditDateBoundary,
  parseAuditLogFilterQuery,
} from "../utils/auditFilters";

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_WALLET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function parse(query: Record<string, unknown>) {
  const result = parseAuditLogFilterQuery(query);
  if (!result.ok) throw new Error(`expected valid filters, got ${result.error.code}`);
  return result.filters;
}

function parseError(query: Record<string, unknown>) {
  const result = parseAuditLogFilterQuery(query);
  if (result.ok) throw new Error("expected the query to be rejected");
  return result.error;
}

describe("parseAuditLogFilterQuery", () => {
  it("returns no filters for an empty query", () => {
    expect(parse({})).toEqual({});
  });

  it("ignores blank and whitespace-only values, as an unfilled form sends them", () => {
    expect(
      parse({ wallet: "", action: "  ", startDate: " ", endDate: "", userId: " ", resource: "" }),
    ).toEqual({});
  });

  it("ignores pagination parameters, which the route handles", () => {
    expect(parse({ limit: "5", cursor: "abc" })).toEqual({});
  });

  describe("wallet", () => {
    it("accepts a valid Stellar key and upper-cases it", () => {
      expect(parse({ wallet: `  ${WALLET.toLowerCase()} ` })).toEqual({ wallet: WALLET });
    });

    it.each([
      ["too short", "GABC"],
      ["not a G address", `S${WALLET.slice(1)}`],
      ["invalid base32 characters (0, 1, 8, 9)", `G${"0189".repeat(14)}`],
      ["57 characters", `${WALLET}A`],
      ["an email", "admin@example.com"],
    ])("rejects %s", (_label, wallet) => {
      expect(parseError({ wallet })).toMatchObject({ code: "INVALID_WALLET", field: "wallet" });
    });

    it("rejects a repeated wallet parameter", () => {
      expect(parseError({ wallet: [WALLET, OTHER_WALLET] })).toMatchObject({
        code: "INVALID_WALLET",
      });
    });
  });

  describe("action", () => {
    it("accepts a single action", () => {
      expect(parse({ action: "ADMIN_ACTION_CONFIRMED" })).toEqual({
        actions: ["ADMIN_ACTION_CONFIRMED"],
      });
    });

    it("accepts a comma-separated list, trimming and de-duplicating", () => {
      expect(parse({ action: " A , B,,A ,C " })).toEqual({ actions: ["A", "B", "C"] });
    });

    it("accepts a repeated parameter (?action=A&action=B)", () => {
      expect(parse({ action: ["A", "B,C"] })).toEqual({ actions: ["A", "B", "C"] });
    });

    it("allows the maximum number of actions and rejects one more", () => {
      const names = (n: number) => Array.from({ length: n }, (_, i) => `ACTION_${i}`).join(",");

      expect(parse({ action: names(AUDIT_MAX_ACTION_FILTERS) }).actions).toHaveLength(
        AUDIT_MAX_ACTION_FILTERS,
      );
      expect(parseError({ action: names(AUDIT_MAX_ACTION_FILTERS + 1) })).toMatchObject({
        code: "INVALID_ACTION",
      });
    });

    it.each([
      ["a space inside a name", "BAD ACTION"],
      ["an angle bracket", "<script>"],
      ["a name over 100 characters", "A".repeat(101)],
    ])("rejects %s", (_label, action) => {
      expect(parseError({ action })).toMatchObject({ code: "INVALID_ACTION", field: "action" });
    });

    it("rejects a non-string entry", () => {
      expect(parseError({ action: ["A", { $ne: "B" }] })).toMatchObject({ code: "INVALID_ACTION" });
    });
  });

  describe("date range", () => {
    it("treats a date-only startDate as the start of that UTC day", () => {
      expect(parse({ startDate: "2025-03-01" }).startDate).toBe("2025-03-01T00:00:00.000Z");
    });

    it("treats a date-only endDate as the end of that UTC day, so the day is included", () => {
      expect(parse({ endDate: "2025-03-31" }).endDate).toBe("2025-03-31T23:59:59.999Z");
    });

    it("normalises an ISO date-time with an offset to a UTC instant", () => {
      expect(parse({ startDate: "2025-03-01T10:00:00+02:00" }).startDate).toBe(
        "2025-03-01T08:00:00.000Z",
      );
    });

    it("accepts a date-time without seconds", () => {
      expect(parse({ endDate: "2025-03-01T10:30Z" }).endDate).toBe("2025-03-01T10:30:00.000Z");
    });

    it("accepts a range that starts and ends on the same day", () => {
      expect(parse({ startDate: "2025-03-01", endDate: "2025-03-01" })).toEqual({
        startDate: "2025-03-01T00:00:00.000Z",
        endDate: "2025-03-01T23:59:59.999Z",
      });
    });

    it.each([
      ["free text", "yesterday"],
      ["a bare number, which Date() would read as a year", "1"],
      ["a calendar rollover (Feb 30)", "2025-02-30"],
      ["month 13", "2025-13-01"],
      ["a date-time with no zone (local-time ambiguity)", "2025-03-01T10:00:00"],
      ["an unpadded date", "2025-3-1"],
      ["an out-of-range hour", "2025-03-01T25:00:00Z"],
    ])("rejects %s", (_label, startDate) => {
      expect(parseError({ startDate })).toMatchObject({ code: "INVALID_DATE", field: "startDate" });
      expect(parseError({ endDate: startDate })).toMatchObject({ code: "INVALID_DATE", field: "endDate" });
    });

    it("rejects an inverted range", () => {
      expect(parseError({ startDate: "2025-03-02", endDate: "2025-03-01" })).toMatchObject({
        code: "INVALID_DATE_RANGE",
      });
    });

    it("rejects an inverted range down to the millisecond", () => {
      expect(
        parseError({ startDate: "2025-03-01T10:00:00.001Z", endDate: "2025-03-01T10:00:00.000Z" }),
      ).toMatchObject({ code: "INVALID_DATE_RANGE" });
    });

    it("rejects a repeated date parameter", () => {
      expect(parseError({ startDate: ["2025-03-01", "2025-03-02"] })).toMatchObject({
        code: "INVALID_DATE",
      });
    });
  });

  it("rejects an array for the single-valued userId and resource filters", () => {
    expect(parseError({ userId: ["a", "b"] })).toMatchObject({ code: "INVALID_FILTER", field: "userId" });
    expect(parseError({ resource: ["a", "b"] })).toMatchObject({ code: "INVALID_FILTER", field: "resource" });
  });

  it("combines every filter", () => {
    expect(
      parse({
        userId: "admin-1",
        resource: "VAULT",
        wallet: WALLET,
        action: "A,B",
        startDate: "2025-03-01",
        endDate: "2025-03-31",
      }),
    ).toEqual({
      userId: "admin-1",
      resource: "VAULT",
      wallet: WALLET,
      actions: ["A", "B"],
      startDate: "2025-03-01T00:00:00.000Z",
      endDate: "2025-03-31T23:59:59.999Z",
    });
  });

  it("never echoes a raw parser error in its messages", () => {
    const error = parseError({ startDate: "not-a-date" });

    expect(error.message).not.toMatch(/Invalid Date|NaN|RangeError/);
  });
});

describe("parseAuditDateBoundary", () => {
  it("returns null rather than throwing on invalid input", () => {
    expect(parseAuditDateBoundary("", "start")).toBeNull();
    expect(parseAuditDateBoundary("2025-02-29", "end")).toBeNull();
  });

  it("accepts a leap day only in a leap year", () => {
    expect(parseAuditDateBoundary("2024-02-29", "start")).toBe("2024-02-29T00:00:00.000Z");
    expect(parseAuditDateBoundary("2025-02-29", "start")).toBeNull();
  });
});

describe("auditEntryInvolvesWallet", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    userId: "admin-1",
    resourceId: undefined as string | undefined,
    changes: undefined as Record<string, unknown> | undefined,
    ...overrides,
  });

  it("matches the acting identity", () => {
    expect(auditEntryInvolvesWallet(entry({ userId: WALLET }), WALLET)).toBe(true);
  });

  it("matches the targeted resource", () => {
    expect(auditEntryInvolvesWallet(entry({ resourceId: WALLET }), WALLET)).toBe(true);
  });

  it("matches a wallet recorded in changes", () => {
    expect(auditEntryInvolvesWallet(entry({ changes: { walletAddress: WALLET } }), WALLET)).toBe(true);
  });

  it("finds a wallet nested inside changes", () => {
    const changes = { before: { owner: OTHER_WALLET }, after: { owner: WALLET } };

    expect(auditEntryInvolvesWallet(entry({ changes }), WALLET)).toBe(true);
    expect(auditEntryInvolvesWallet(entry({ changes }), OTHER_WALLET)).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    expect(auditEntryInvolvesWallet(entry({ userId: WALLET.toLowerCase() }), WALLET)).toBe(true);
    expect(auditEntryInvolvesWallet(entry({ userId: WALLET }), WALLET.toLowerCase())).toBe(true);
  });

  it("does not match a different wallet", () => {
    expect(auditEntryInvolvesWallet(entry({ userId: OTHER_WALLET }), WALLET)).toBe(false);
  });

  it("does not match a wallet-looking value under an unrelated key", () => {
    expect(auditEntryInvolvesWallet(entry({ changes: { note: WALLET } }), WALLET)).toBe(false);
  });

  it("does not match a substring of another value", () => {
    expect(auditEntryInvolvesWallet(entry({ changes: { wallet: `${WALLET}EXTRA` } }), WALLET)).toBe(false);
  });

  it("stops searching past the depth limit", () => {
    const deep = { a: { b: { c: { d: { wallet: WALLET } } } } };

    expect(auditEntryInvolvesWallet(entry({ changes: deep }), WALLET)).toBe(false);
  });

  it("handles an entry with no changes", () => {
    expect(auditEntryInvolvesWallet(entry(), WALLET)).toBe(false);
  });

  it("ignores non-string values under wallet keys", () => {
    const changes = { wallet: 42, address: null, owner: ["x"], account: { nested: true } };

    expect(auditEntryInvolvesWallet(entry({ changes }), WALLET)).toBe(false);
  });
});
