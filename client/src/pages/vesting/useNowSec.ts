/**
 * Returns the current Unix timestamp in whole seconds, updating every second.
 * Used by vesting UI to re-evaluate unlock boundaries without waiting for user input.
 */
import { useEffect, useState } from "react";

export function useNowSec(): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return nowSec;
}
