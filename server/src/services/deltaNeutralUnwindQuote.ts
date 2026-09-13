/**
 * Unwind preview for the delta-neutral strategy (#1171).
 *
 * Estimates the expected proceeds of closing a position
 * (contracts/strategies/delta_neutral) from stored position data and the
 * current oracle price — no contract changes, since the perp exchange
 * interface exposes no read-only "current value" view. This is always a
 * best-effort estimate (isEstimate: true), never a binding quote.
 *
 * Leg independence:
 *   - The spot leg needs a live price to be valued in USDC at all, so it
 *     becomes "unavailable" whenever the oracle is unreachable.
 *   - The perp leg can still report a funding-only floor (accrued funding,
 *     excluding any price-based PnL) when the oracle is down, so it stays
 *     "quoted" with a caveat in riskNotes rather than going unavailable.
 */
import { simulateReadOnlyCall, addressArg } from "./sorobanReader";

const SCALE = 10_000_000n; // 1e7, matching the contract's fixed-point scale
/** Flat assumed AMM swap fee for the spot leg — no live quoting surface exists on-chain for this. */
const ASSUMED_SPOT_FEE_BPS = 30;

export interface DeltaNeutralUnwindLeg {
  leg: "spot" | "perp";
  status: "quoted" | "unavailable";
  expectedOutputUsdc?: string;
  feeUsdc?: string;
  reason?: string;
}

export interface DeltaNeutralUnwindQuote {
  depositor: string;
  legs: DeltaNeutralUnwindLeg[];
  totalExpectedUsdc?: string;
  canExecute: boolean;
  riskNotes: string[];
  isEstimate: true;
  quotedAt: string;
}

interface RawPosition {
  owner: string;
  usdc_deposited: bigint | number;
  spot_amount: bigint | number;
  perp_notional: bigint | number;
  entry_price: bigint | number;
  funding_collected: bigint | number;
  is_open: boolean;
}

export async function getUnwindQuote(
  contractId: string,
  spotTokenId: string,
  oracleContractId: string,
  depositor: string,
): Promise<DeltaNeutralUnwindQuote> {
  try {
    return await computeUnwindQuote(contractId, spotTokenId, oracleContractId, depositor);
  } catch {
    // Malformed input (e.g. an invalid address slipping past route validation)
    // must still resolve to a safe, non-executable preview — never throw.
    const reason = "Unwind preview could not be computed.";
    return {
      depositor,
      legs: [
        { leg: "spot", status: "unavailable", reason },
        { leg: "perp", status: "unavailable", reason },
      ],
      canExecute: false,
      riskNotes: [reason],
      isEstimate: true,
      quotedAt: new Date().toISOString(),
    };
  }
}

async function computeUnwindQuote(
  contractId: string,
  spotTokenId: string,
  oracleContractId: string,
  depositor: string,
): Promise<DeltaNeutralUnwindQuote> {
  const quotedAt = new Date().toISOString();
  const riskNotes: string[] = [];

  const positionResult = await simulateReadOnlyCall<RawPosition | null>(
    contractId,
    "get_position",
    [addressArg(depositor)],
  );

  if (!positionResult.ok || !positionResult.value || !positionResult.value.is_open) {
    const reason = "No open position found for this depositor.";
    return {
      depositor,
      legs: [
        { leg: "spot", status: "unavailable", reason },
        { leg: "perp", status: "unavailable", reason },
      ],
      canExecute: false,
      riskNotes: [reason],
      isEstimate: true,
      quotedAt,
    };
  }

  const position = positionResult.value;
  const spotAmount = BigInt(position.spot_amount);
  const perpNotional = BigInt(position.perp_notional);
  const entryPrice = BigInt(position.entry_price);
  const fundingCollected = BigInt(position.funding_collected);

  const priceResult = await simulateReadOnlyCall<bigint | number>(
    oracleContractId,
    "get_price",
    [addressArg(spotTokenId)],
  );

  const legs: DeltaNeutralUnwindLeg[] = [];

  if (!priceResult.ok) {
    legs.push({
      leg: "spot",
      status: "unavailable",
      reason: "Price oracle unreachable — cannot value spot holdings in USDC.",
    });
    legs.push({
      leg: "perp",
      status: "quoted",
      expectedOutputUsdc: fundingCollected.toString(),
    });
    riskNotes.push(
      "Price oracle unreachable: perp leg shows accrued funding only, excluding any price-based PnL.",
    );
    return {
      depositor,
      legs,
      canExecute: false,
      riskNotes,
      isEstimate: true,
      quotedAt,
    };
  }

  const currentPrice = BigInt(priceResult.value);

  // Spot leg — value at current oracle price, minus an assumed flat fee.
  const spotGrossUsdc = (spotAmount * currentPrice) / SCALE;
  const spotFeeUsdc = (spotGrossUsdc * BigInt(ASSUMED_SPOT_FEE_BPS)) / 10_000n;
  const spotNetUsdc = spotGrossUsdc - spotFeeUsdc;
  legs.push({
    leg: "spot",
    status: "quoted",
    expectedOutputUsdc: spotNetUsdc.toString(),
    feeUsdc: spotFeeUsdc.toString(),
  });
  riskNotes.push(
    `Spot leg assumes a flat ${ASSUMED_SPOT_FEE_BPS / 100}% AMM fee; actual slippage depends on live pool depth and is not modeled here.`,
  );

  // Perp leg — 1x short PnL estimate plus accrued funding.
  let perpPnl = 0n;
  if (entryPrice !== 0n) {
    perpPnl = ((perpNotional * (entryPrice - currentPrice)) / entryPrice);
  }
  const perpExpectedUsdc = perpNotional + perpPnl + fundingCollected;
  legs.push({
    leg: "perp",
    status: "quoted",
    expectedOutputUsdc: perpExpectedUsdc.toString(),
  });
  riskNotes.push(
    "Perp leg is an off-chain estimate from stored entry price and oracle price; the exchange's real exit price may differ.",
  );

  const totalExpectedUsdc = spotNetUsdc + perpExpectedUsdc;

  return {
    depositor,
    legs,
    totalExpectedUsdc: totalExpectedUsdc.toString(),
    canExecute: true,
    riskNotes,
    isEstimate: true,
    quotedAt,
  };
}
