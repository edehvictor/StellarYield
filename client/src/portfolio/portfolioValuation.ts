export * from "../../../shared/types/portfolioValuation";

import {
  validatePortfolioValuationInputs,
  type ValuationPriceStatus,
} from "../../../shared/types/portfolioValuation";
import { PortfolioValuationError } from "./portfolioValuationErrors";

/** Shape accepted by the portfolio dashboard after boundary validation. */
export interface RefreshPortfolioPosition {
  protocol: string;
  asset: string;
  deposited: number;
  currentValue: number | null;
  apy: number;
  shares: number;
  fetchedAt?: string | null;
  isPriceUnavailable?: boolean;
  priceStatus?: ValuationPriceStatus;
}

/**
 * Validate an untrusted refresh payload before it reaches component state.
 *
 * Throws a typed {@link PortfolioValuationError} on the first malformed field so
 * callers keep their last accepted positions and may retry safely.
 */
export function parseRefreshedPositions(payload: unknown): RefreshPortfolioPosition[] {
  const validated = validatePortfolioValuationInputs(payload);
  if (!validated.ok) {
    throw new PortfolioValuationError({
      code: "INVALID_VALUATION_DATA",
      message: "Received invalid portfolio valuation data. Displaying last known positions.",
      retryable: true,
      timestamp: new Date().toISOString(),
    });
  }

  return validated.positions.map((position) => ({
    protocol: position.protocol,
    asset: position.asset,
    deposited: position.deposited ?? 0,
    currentValue: position.currentValue ?? null,
    apy: position.apy ?? 0,
    shares: position.shares ?? 0,
    ...(position.fetchedAt !== undefined ? { fetchedAt: position.fetchedAt } : {}),
    ...(position.isPriceUnavailable !== undefined
      ? { isPriceUnavailable: position.isPriceUnavailable }
      : {}),
    ...(position.priceStatus !== undefined ? { priceStatus: position.priceStatus } : {}),
  }));
}
