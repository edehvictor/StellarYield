import { describe, expect, it } from "vitest";
import {
  formatSettlementTimeRemaining,
  getSettlementWindowStatus,
} from "./settlementWindow";

describe("withdrawal settlement window", () => {
  it("reports remaining time until the estimated settlement deadline", () => {
    expect(getSettlementWindowStatus(90_000, 30_000)).toEqual({
      state: "pending",
      remainingSeconds: 60,
    });
  });

  it("marks the estimate elapsed at or after its deadline", () => {
    expect(getSettlementWindowStatus(30_000, 30_000)).toEqual({
      state: "elapsed",
      remainingSeconds: 0,
    });
    expect(getSettlementWindowStatus(20_000, 30_000)).toEqual({
      state: "elapsed",
      remainingSeconds: 0,
    });
  });

  it("formats remaining time at seconds, minutes, and hours scales", () => {
    expect(formatSettlementTimeRemaining(12)).toBe("12s");
    expect(formatSettlementTimeRemaining(125)).toBe("2m 5s");
    expect(formatSettlementTimeRemaining(86_400)).toBe("24h 0m");
  });
});
