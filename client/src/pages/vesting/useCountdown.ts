/**
 * useCountdown.ts
 *
 * React hook that returns a live countdown string (DD HH MM SS) to the
 * given Unix timestamp (seconds).
 */
import { useEffect, useState } from "react";

export interface CountdownParts {
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
    expired: boolean;
}

/**
 * Returns live countdown parts to `targetTimestamp` (Unix seconds).
 * Updates every second. `expired` is true when the target is in the past.
 */
export function useCountdown(targetTimestamp: number): CountdownParts {
    function compute(): CountdownParts {
        const diffMs = targetTimestamp * 1000 - Date.now();
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

    const [parts, setParts] = useState<CountdownParts>(compute);

    useEffect(() => {
        const id = setInterval(() => setParts(compute()), 1000);
        return () => clearInterval(id);
    }, [targetTimestamp]); // eslint-disable-line react-hooks/exhaustive-deps

    return parts;
}
