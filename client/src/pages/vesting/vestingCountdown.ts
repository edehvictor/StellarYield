/**
 * Pure helpers for vesting countdown display and unlock-boundary resolution.
 */

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

export interface VestingScheduleTimestamps {
  cliffTimestamp: number;
  endTimestamp: number;
  nextUnlockTimestamp: number;
}

export interface VestingCountdownState {
  countdownTarget: number;
  countdownLabel: string;
  isCliffReached: boolean;
  isFullyVested: boolean;
}

/** Compute countdown parts to `targetTimestamp` (Unix seconds). */
export function computeCountdownParts(
  targetTimestamp: number,
  nowMs: number = Date.now(),
): CountdownParts {
  const diffMs = targetTimestamp * 1000 - nowMs;
  if (diffMs <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }
  const totalSeconds = Math.floor(diffMs / 1000);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: false,
  };
}

/** Resolve which unlock boundary the dashboard should count down to. */
export function resolveVestingCountdown(
  schedule: VestingScheduleTimestamps,
  nowSec: number,
): VestingCountdownState {
  const isCliffReached = nowSec >= schedule.cliffTimestamp;
  const isFullyVested = nowSec >= schedule.endTimestamp;
  const countdownTarget = isCliffReached
    ? schedule.nextUnlockTimestamp
    : schedule.cliffTimestamp;
  const countdownLabel = isCliffReached ? "Next unlock in" : "Cliff unlocks in";
  return { countdownTarget, countdownLabel, isCliffReached, isFullyVested };
}
