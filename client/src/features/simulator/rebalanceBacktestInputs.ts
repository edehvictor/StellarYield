/**
 * APY input handling for the rebalance backtest form (#1407).
 *
 * Yields can be negative (a depeg, a slashing event, a strategy that costs more
 * than it earns), so the field keeps the raw text the user types — a lone "-"
 * is a valid step towards "-5" — and parses it only when the form is submitted.
 * The bounds mirror `server/src/services/simulationService.ts`; the server
 * still re-validates every request.
 */

/**
 * Lowest annualised APY accepted as a standing assumption: a total loss over a
 * year. Use a per-day series (API `dailyApy`) to model a sharper, shorter loss.
 */
export const MIN_ANNUAL_APY_PCT = -100;

export type ApyParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Parse the text of an APY field. Blank means 0, as the field always has.
 * Accepts a leading minus (also the Unicode minus sign that some keyboards and
 * spreadsheets paste) and a decimal point.
 */
export function parseApyInput(text: string): ApyParseResult {
  const normalized = text.trim().replace(/−/g, "-");
  if (normalized === "") return { ok: true, value: 0 };

  if (!/^-?\d+(\.\d+)?$/.test(normalized) && !/^-?\.\d+$/.test(normalized)) {
    return { ok: false, error: "Enter a number, for example 8 or -2.5." };
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Enter a number, for example 8 or -2.5." };
  }
  if (value < MIN_ANNUAL_APY_PCT) {
    return {
      ok: false,
      error: `APY cannot be below ${MIN_ANNUAL_APY_PCT}% (a total loss over a year).`,
    };
  }
  return { ok: true, value };
}

export interface ApyRowInput {
  label: string;
  apyText: string;
}

export type ApyRowsResult =
  | { ok: true; values: number[] }
  | { ok: false; error: string; rowIndex: number };

/** Parse every row's APY; the first invalid row is reported by label. */
export function parseApyRows(rows: ApyRowInput[]): ApyRowsResult {
  const values: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseApyInput(rows[i].apyText);
    if (!parsed.ok) {
      const name = rows[i].label.trim() || `Allocation ${i + 1}`;
      return { ok: false, error: `${name}: ${parsed.error}`, rowIndex: i };
    }
    values.push(parsed.value);
  }
  return { ok: true, values };
}
