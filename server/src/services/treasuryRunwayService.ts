/**
 * Treasury reserve runway calculation (#1161).
 *
 * Projects when the treasury's reserve balance will cross a configured
 * reserve threshold, based on average net daily cashflow, so reserve
 * warnings stay stable as new cashflow rows come in.
 */

export interface RunwayCashflowEntry {
  /** ISO 8601 date. */
  date: string;
  /** Net amount for the day: positive = inflow, negative = outflow. */
  amount: number;
}

export type RunwayStatus = "healthy" | "warning" | "breach";

export interface RunwayResult {
  netDailyFlow: number;
  currentReserve: number;
  reserveThreshold: number;
  /** Days until the reserve balance is projected to cross the threshold, or
   * `null` if it never will at the current flow rate (flat or growing). */
  daysToBreach: number | null;
  breachDate: string | null;
  status: RunwayStatus;
}

/** Breaches projected within this many days are surfaced as "warning" rather than "healthy". */
const WARNING_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function calculateTreasuryRunway(
  currentReserve: number,
  cashflows: RunwayCashflowEntry[],
  reserveThreshold: number,
  asOf: Date = new Date(),
): RunwayResult {
  const netDailyFlow =
    cashflows.length === 0
      ? 0
      : Math.round((cashflows.reduce((sum, c) => sum + c.amount, 0) / cashflows.length) * 100) /
        100;

  if (currentReserve <= reserveThreshold) {
    return {
      netDailyFlow,
      currentReserve,
      reserveThreshold,
      daysToBreach: 0,
      breachDate: asOf.toISOString().slice(0, 10),
      status: "breach",
    };
  }

  if (netDailyFlow >= 0) {
    return {
      netDailyFlow,
      currentReserve,
      reserveThreshold,
      daysToBreach: null,
      breachDate: null,
      status: "healthy",
    };
  }

  const daysToBreach = Math.ceil((currentReserve - reserveThreshold) / -netDailyFlow);
  const breachDate = new Date(asOf.getTime() + daysToBreach * MS_PER_DAY).toISOString().slice(0, 10);
  const status: RunwayStatus = daysToBreach <= WARNING_WINDOW_DAYS ? "warning" : "healthy";

  return { netDailyFlow, currentReserve, reserveThreshold, daysToBreach, breachDate, status };
}
