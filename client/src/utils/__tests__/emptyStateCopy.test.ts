import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE_APY,
  EMPTY_STATE_STRATEGY_HEALTH,
  EMPTY_STATE_PROVIDER_UPTIME,
  EMPTY_STATE_COMPATIBILITY,
  EMPTY_STATE_ATTRIBUTION,
  EMPTY_STATE_SHARE_PRICE,
  EMPTY_STATE_APY_HISTORY,
  EMPTY_STATE_CORRELATION,
  EMPTY_STATE_PROTOCOL_DISTRIBUTION,
  EMPTY_STATE_REBALANCE,
  EMPTY_STATE_VAULT_NOT_FOUND,
  EMPTY_STATE_VAULT_UNAVAILABLE,
} from "../emptyStateCopy";

const ALL_COPY_ENTRIES = [
  EMPTY_STATE_APY,
  EMPTY_STATE_STRATEGY_HEALTH,
  EMPTY_STATE_PROVIDER_UPTIME,
  EMPTY_STATE_COMPATIBILITY,
  EMPTY_STATE_ATTRIBUTION,
  EMPTY_STATE_SHARE_PRICE,
  EMPTY_STATE_APY_HISTORY,
  EMPTY_STATE_CORRELATION,
  EMPTY_STATE_PROTOCOL_DISTRIBUTION,
  EMPTY_STATE_REBALANCE,
  EMPTY_STATE_VAULT_NOT_FOUND,
  EMPTY_STATE_VAULT_UNAVAILABLE,
];

describe("emptyStateCopy", () => {
  for (const entry of ALL_COPY_ENTRIES) {
    it(`has a non-empty title for "${entry.title}"`, () => {
      expect(entry.title.length).toBeGreaterThan(0);
    });

    it(`has a non-empty description for "${entry.title}"`, () => {
      expect(entry.description.length).toBeGreaterThan(0);
    });

    it(`title does not end with a period for "${entry.title}"`, () => {
      expect(entry.title.endsWith(".")).toBe(false);
    });
  }

  it("all copy entries share consistent structure", () => {
    for (const entry of ALL_COPY_ENTRIES) {
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.description).toBe("string");
    }
  });
});
