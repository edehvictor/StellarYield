import { describe, expect, it } from "vitest";
import {
  AUDIT_MAX_ACTION_FILTERS,
  EMPTY_AUDIT_FILTER_FORM,
  buildAuditLogQuery,
  describeActiveAuditFilters,
  hasActiveAuditFilters,
  hasFormErrors,
  parseActionList,
  validateAuditFilterForm,
  type AuditLogFilterForm,
} from "./auditLogFilters";

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const form = (overrides: Partial<AuditLogFilterForm> = {}): AuditLogFilterForm => ({
  ...EMPTY_AUDIT_FILTER_FORM,
  ...overrides,
});

describe("parseActionList", () => {
  it("trims, drops blanks and de-duplicates", () => {
    expect(parseActionList(" A , B,,A ,C ")).toEqual(["A", "B", "C"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseActionList("  ,  ")).toEqual([]);
  });
});

describe("validateAuditFilterForm", () => {
  it("accepts an empty form", () => {
    expect(validateAuditFilterForm(EMPTY_AUDIT_FILTER_FORM)).toEqual({});
  });

  it("accepts a fully populated, valid form", () => {
    const errors = validateAuditFilterForm(
      form({ wallet: WALLET.toLowerCase(), actions: "A, B", startDate: "2025-03-01", endDate: "2025-03-31" }),
    );

    expect(errors).toEqual({});
  });

  it.each(["GABC", `S${WALLET.slice(1)}`, "not a wallet"])("rejects the wallet %p", (wallet) => {
    expect(validateAuditFilterForm(form({ wallet })).wallet).toMatch(/Stellar public key/);
  });

  it("rejects an action with disallowed characters", () => {
    expect(validateAuditFilterForm(form({ actions: "GOOD,<bad>" })).actions).toBeDefined();
  });

  it("allows the maximum number of actions and rejects one more", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `A${i}`).join(",");

    expect(validateAuditFilterForm(form({ actions: names(AUDIT_MAX_ACTION_FILTERS) })).actions).toBeUndefined();
    expect(validateAuditFilterForm(form({ actions: names(AUDIT_MAX_ACTION_FILTERS + 1) })).actions).toBeDefined();
  });

  it.each(["2025-02-30", "2025-13-01", "01/02/2025", "yesterday"])("rejects the date %p", (date) => {
    expect(validateAuditFilterForm(form({ startDate: date })).startDate).toBeDefined();
    expect(validateAuditFilterForm(form({ endDate: date })).endDate).toBeDefined();
  });

  it("accepts a leap day only in a leap year", () => {
    expect(validateAuditFilterForm(form({ startDate: "2024-02-29" })).startDate).toBeUndefined();
    expect(validateAuditFilterForm(form({ startDate: "2025-02-29" })).startDate).toBeDefined();
  });

  it("rejects an end date before the start date, but accepts the same day", () => {
    expect(validateAuditFilterForm(form({ startDate: "2025-03-02", endDate: "2025-03-01" })).endDate).toMatch(
      /before the start/,
    );
    expect(validateAuditFilterForm(form({ startDate: "2025-03-01", endDate: "2025-03-01" }))).toEqual({});
  });

  it("does not add a range error on top of an invalid date", () => {
    const errors = validateAuditFilterForm(form({ startDate: "2025-02-30", endDate: "2025-01-01" }));

    expect(errors.startDate).toBeDefined();
    expect(errors.endDate).toBeUndefined();
  });

  it("reports several problems at once", () => {
    const errors = validateAuditFilterForm(form({ wallet: "x", actions: "<", startDate: "bad" }));

    expect(Object.keys(errors).sort()).toEqual(["actions", "startDate", "wallet"]);
    expect(hasFormErrors(errors)).toBe(true);
  });
});

describe("buildAuditLogQuery", () => {
  it("is empty for an unfiltered request", () => {
    expect(buildAuditLogQuery(EMPTY_AUDIT_FILTER_FORM)).toBe("");
  });

  it("normalises and encodes every filter", () => {
    const query = new URLSearchParams(
      buildAuditLogQuery(
        form({ wallet: ` ${WALLET.toLowerCase()} `, actions: "A, B", startDate: "2025-03-01", endDate: "2025-03-31" }),
      ),
    );

    expect(query.get("wallet")).toBe(WALLET);
    expect(query.get("action")).toBe("A,B");
    expect(query.get("startDate")).toBe("2025-03-01");
    expect(query.get("endDate")).toBe("2025-03-31");
  });

  it("omits blank filters", () => {
    const query = new URLSearchParams(buildAuditLogQuery(form({ actions: "A" })));

    expect([...query.keys()]).toEqual(["action"]);
  });

  it("adds pagination parameters", () => {
    const query = new URLSearchParams(buildAuditLogQuery(EMPTY_AUDIT_FILTER_FORM, { cursor: "abc", limit: 25 }));

    expect(query.get("cursor")).toBe("abc");
    expect(query.get("limit")).toBe("25");
  });

  it("ignores a null cursor", () => {
    expect(buildAuditLogQuery(EMPTY_AUDIT_FILTER_FORM, { cursor: null })).toBe("");
  });
});

describe("hasActiveAuditFilters / describeActiveAuditFilters", () => {
  it("reports no active filters for a blank form", () => {
    expect(hasActiveAuditFilters(EMPTY_AUDIT_FILTER_FORM)).toBe(false);
    expect(hasActiveAuditFilters(form({ wallet: "   ", actions: " , " }))).toBe(false);
    expect(describeActiveAuditFilters(EMPTY_AUDIT_FILTER_FORM)).toEqual([]);
  });

  it("describes each active filter", () => {
    expect(
      describeActiveAuditFilters(form({ wallet: WALLET, actions: "A,B", startDate: "2025-03-01", endDate: "2025-03-31" })),
    ).toEqual([`Wallet ${WALLET.slice(0, 4)}…${WALLET.slice(-4)}`, "Actions: A, B", "2025-03-01 → 2025-03-31"]);
  });

  it("describes a half-open range", () => {
    expect(describeActiveAuditFilters(form({ startDate: "2025-03-01" }))).toEqual(["From 2025-03-01"]);
    expect(describeActiveAuditFilters(form({ endDate: "2025-03-31" }))).toEqual(["Until 2025-03-31"]);
  });
});
