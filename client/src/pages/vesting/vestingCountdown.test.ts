import { describe, it, expect } from "vitest";
import { resolveVestingCountdown } from "./vestingCountdown";

const BASE_SCHEDULE = {
  cliffTimestamp: 1_700_000_000,
  endTimestamp: 1_700_086_400,
  nextUnlockTimestamp: 1_700_043_200,
};

describe("resolveVestingCountdown", () => {
  it("targets cliff before the cliff timestamp", () => {
    const state = resolveVestingCountdown(BASE_SCHEDULE, BASE_SCHEDULE.cliffTimestamp - 1);
    expect(state.countdownTarget).toBe(BASE_SCHEDULE.cliffTimestamp);
    expect(state.countdownLabel).toBe("Cliff unlocks in");
    expect(state.isCliffReached).toBe(false);
    expect(state.isFullyVested).toBe(false);
  });

  it("rolls over to next unlock exactly at cliff boundary", () => {
    const state = resolveVestingCountdown(BASE_SCHEDULE, BASE_SCHEDULE.cliffTimestamp);
    expect(state.countdownTarget).toBe(BASE_SCHEDULE.nextUnlockTimestamp);
    expect(state.countdownLabel).toBe("Next unlock in");
    expect(state.isCliffReached).toBe(true);
    expect(state.isFullyVested).toBe(false);
  });

  it("marks fully vested at end timestamp", () => {
    const state = resolveVestingCountdown(BASE_SCHEDULE, BASE_SCHEDULE.endTimestamp);
    expect(state.isFullyVested).toBe(true);
    expect(state.isCliffReached).toBe(true);
  });

  it("keeps post-cliff countdown target after next unlock passes", () => {
    const state = resolveVestingCountdown(
      BASE_SCHEDULE,
      BASE_SCHEDULE.nextUnlockTimestamp + 60,
    );
    expect(state.countdownTarget).toBe(BASE_SCHEDULE.nextUnlockTimestamp);
    expect(state.countdownLabel).toBe("Next unlock in");
    expect(state.isFullyVested).toBe(false);
  });
});
