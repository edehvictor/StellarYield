/**
 * Delta-neutral unwind preview — client contract & presentation helpers.
 * Mirrors GET /api/strategies/delta-neutral/:contractId/unwind-quote.
 */

export interface UnwindLeg {
  leg: "spot" | "perp";
  status: "quoted" | "unavailable";
  expectedOutputUsdc?: string;
  feeUsdc?: string;
  reason?: string;
}

export interface UnwindQuote {
  depositor: string;
  legs: UnwindLeg[];
  totalExpectedUsdc?: string;
  canExecute: boolean;
  riskNotes: string[];
  isEstimate: true;
  quotedAt: string;
}

/** Whether the confirm/close-position action may proceed — mirrors the server's canExecute gate. */
export function canSubmit(quote: UnwindQuote | null): boolean {
  if (!quote) return false;
  return quote.canExecute && quote.legs.every((leg) => leg.status === "quoted");
}

export function unavailableLegs(quote: UnwindQuote): UnwindLeg[] {
  return quote.legs.filter((leg) => leg.status === "unavailable");
}

/** Formats a raw USDC base-unit string (7-decimal scale) as a dollar amount. */
export function formatUsdc(raw: string | undefined): string {
  if (raw === undefined) return "—";
  const value = Number(BigInt(raw)) / 1e7;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
