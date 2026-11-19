import { describe, expect, it } from "vitest";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { PreparedTransaction, type PreparedTransactionMeta } from "../src/lifecycle";
import { toTokenUnits } from "../src/types";
import {
  createDepositSimulation,
  depositSimulationScenarios,
  type DepositSimulationScenario,
} from "./fixtures/depositSimulation";

describe("vault deposit simulation fixtures", () => {
  for (const scenario of depositSimulationScenarios) {
    it(`parses exact fees, shares and reserves: ${scenario.name}`, () => {
      const restored: DepositSimulationScenario = JSON.parse(JSON.stringify(scenario));
      const simulation = createDepositSimulation(restored);
      expect(rpc.Api.isSimulationSuccess(simulation)).toBe(true);
      const shares = scValToNative(
        xdr.ScVal.fromXDR(simulation.result!.retval.toXDR("base64"), "base64")
      ) as bigint;
      expect(shares).toBe(toTokenUnits(scenario.mintedShares));
      expect(shares).toBeGreaterThanOrEqual(toTokenUnits(scenario.minSharesOut));
      expect(simulation.transactionData.build().resourceFee().toString()).toBe(
        scenario.minResourceFee
      );
      expect(toTokenUnits(scenario.reserveBefore) + toTokenUnits(scenario.amount)).toBe(
        toTokenUnits(scenario.reserveAfter)
      );

      const meta: PreparedTransactionMeta<bigint> = {
        simulationResult: shares,
        minResourceFee: simulation.minResourceFee,
        footprint: simulation.transactionData.build().resources().footprint().toXDR("base64"),
        transactionData: simulation.transactionData.build().toXDR("base64"),
        authEntries: [],
        latestLedger: simulation.latestLedger,
        validUntilLedger: simulation.latestLedger + 100,
        contractId: "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M",
        networkPassphrase: "Test SDF Network ; September 2015",
        method: "deposit",
        argsHash: JSON.stringify({ amount: scenario.amount, min_shares_out: scenario.minSharesOut }),
      };
      const prepared = new PreparedTransaction<bigint>("", meta);
      expect(prepared.meta.simulationResult).toBe(shares);
      expect(prepared.meta.minResourceFee).toBe(scenario.minResourceFee);
    });
  }

  it("returns independent simulation data for each consumer", () => {
    const first = createDepositSimulation();
    const second = createDepositSimulation();
    first.transactionData.setResourceFee(1n);
    expect(second.transactionData.build().resourceFee().toString()).toBe("1200");
    expect(first.result).not.toBe(second.result);
    expect(first.events).not.toBe(second.events);
  });
});
