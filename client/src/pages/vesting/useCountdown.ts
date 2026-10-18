/**
 * useCountdown.ts
 *
 * React hook that returns a live countdown string (DD HH MM SS) to the
 * given Unix timestamp (seconds).
 */
import { useEffect, useState } from "react";
import { computeCountdownParts, type CountdownParts } from "./vestingCountdown";

export type { CountdownParts };

/**
 * Returns live countdown parts to `targetTimestamp` (Unix seconds).
 * Updates every second. `expired` is true when the target is in the past.
 */
export function useCountdown(targetTimestamp: number): CountdownParts {
  const [parts, setParts] = useState<CountdownParts>(() =>
    computeCountdownParts(targetTimestamp),
  );

  useEffect(() => {
    const tick = () => setParts(computeCountdownParts(targetTimestamp));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetTimestamp]);

  return parts;
}
