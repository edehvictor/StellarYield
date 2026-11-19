import { nativeToScVal, SorobanDataBuilder } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";

/** Decimal strings keep fixture amounts exact and JSON-serializable. */
export interface DepositSimulationScenario {
  name: string;
  amount: string;
  minSharesOut: string;
  mintedShares: string;
  minResourceFee: string;
  reserveBefore: string;
  reserveAfter: string;
}

export const depositSimulationScenarios = [
  {
    name: "first deposit (one share per base unit)",
    amount: "10000000",
    minSharesOut: "10000000",
    mintedShares: "10000000",
    minResourceFee: "1200",
    reserveBefore: "0",
    reserveAfter: "10000000",
  },
  {
    name: "existing vault (two asset units per share)",
    amount: "10000000",
    minSharesOut: "4950000",
    mintedShares: "5000000",
    minResourceFee: "2400",
    reserveBefore: "40000000",
    reserveAfter: "50000000",
  },
  {
    name: "deposit above the JavaScript safe-integer limit",
    amount: "9007199254740993",
    minSharesOut: "9007199254740993",
    mintedShares: "9007199254740993",
    minResourceFee: "3600",
    reserveBefore: "7",
    reserveAfter: "9007199254741000",
  },
] satisfies DepositSimulationScenario[];

/** Each call creates fresh mutable XDR/builder values, avoiding cross-test state. */
export function createDepositSimulation(
  scenario: DepositSimulationScenario = depositSimulationScenarios[0]
): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    id: "deposit-fixture",
    latestLedger: 1000,
    minResourceFee: scenario.minResourceFee,
    transactionData: new SorobanDataBuilder().setResourceFee(BigInt(scenario.minResourceFee)),
    events: [],
    result: {
      auth: [],
      retval: nativeToScVal(BigInt(scenario.mintedShares), { type: "i128" }),
    },
  };
}
