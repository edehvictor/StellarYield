import { useEffect, useState } from "react";
import type { DailyMovement } from "../../../shared/types/dailyMovement";

interface UseDailyMovementOptions {
  walletAddress?: string;
  enabled?: boolean;
}

export function useDailyMovement({ walletAddress, enabled = true }: UseDailyMovementOptions) {
  const [movement, setMovement] = useState<DailyMovement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled || !walletAddress) {
      return;
    }

    let isMounted = true;

    async function fetch() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/portfolio/${walletAddress}/daily-movement`
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch daily movement: ${response.statusText}`);
        }

        const data = await response.json();

        if (isMounted) {
          setMovement(data);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    fetch();

    return () => {
      isMounted = false;
    };
  }, [walletAddress, enabled]);

  return { movement, loading, error };
}

export function useDailyMovementHistory(
  { walletAddress, days = 30, enabled = true }: 
    { walletAddress?: string; days?: number; enabled?: boolean }
) {
  const [history, setHistory] = useState<DailyMovement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled || !walletAddress) {
      return;
    }

    let isMounted = true;

    async function fetch() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/portfolio/${walletAddress}/movement-history?days=${days}`
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch movement history: ${response.statusText}`);
        }

        const data = await response.json();

        if (isMounted) {
          setHistory(data.movements || []);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    fetch();

    return () => {
      isMounted = false;
    };
  }, [walletAddress, days, enabled]);

  return { history, loading, error };
}
