/**
 * Parse a decimal amount string into integer stroops (smallest units).
 */
export function parseDecimalToStroops(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed || !/^-?\d*\.?\d*$/.test(trimmed)) {
    throw new Error("Invalid amount");
  }
  const negative = trimmed.startsWith("-");
  const raw = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ""] = raw.split(".");
  const whole = wholePart || "0";
  const frac = `${fracPart}${"0".repeat(decimals)}`.slice(0, decimals);
  const base = 10n ** BigInt(decimals);
  let v = BigInt(whole) * base + BigInt(frac || "0");
  if (negative) v = -v;
  return v;
}

/**
 * Format stroops as a human-readable decimal string.
 */
export function formatStroopsToDecimal(stroops: bigint, decimals: number): string {
  const neg = stroops < 0n;
  const v = neg ? -stroops : stroops;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}
