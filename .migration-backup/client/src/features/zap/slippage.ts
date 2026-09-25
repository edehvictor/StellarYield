/**
 * Minimum token amount to accept after applying slippage tolerance.
 * Example: 0.5% slippage → multiply expected output by 0.995 (9950/10000).
 */
export function minAmountAfterSlippage(expectedOut: bigint, slippagePercent: number): bigint {
  if (slippagePercent < 0 || slippagePercent >= 100) {
    throw new RangeError("slippagePercent must be in [0, 100)");
  }
  const bps = Math.round((1 - slippagePercent / 100) * 10_000);
  return (expectedOut * BigInt(bps)) / 10_000n;
}
