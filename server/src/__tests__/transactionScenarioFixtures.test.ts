/**
 * Deterministic fixture builder for end-to-end transaction scenarios (#1342).
 */
import { StrKey } from "@stellar/stellar-sdk";
import {
  buildTransactionScenario,
  buildTransactionScenarioMatrix,
  SCENARIO_BASE_TIME,
  SCENARIO_PHASE_STEP_MS,
  SCENARIO_VAULT_CONTRACT_ID,
  SCENARIO_ZAP_CONTRACT_ID,
  type TransactionScenarioSpec,
} from "../../../shared/test-fixtures/transactionScenarios";
import { decodeScError } from "../../../shared/types/contractPanic";

function scenarioErrorCode(spec: TransactionScenarioSpec): string | undefined {
  try {
    buildTransactionScenario(spec);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("buildTransactionScenario", () => {
  it("is deterministic: the same spec yields the same scenario", () => {
    expect(buildTransactionScenario({ seed: 42, action: "deposit" })).toEqual(
      buildTransactionScenario({ seed: 42, action: "deposit" }),
    );
    expect(buildTransactionScenarioMatrix(7)).toEqual(buildTransactionScenarioMatrix(7));
  });

  it("varies with the seed but keeps one wallet per seed across actions", () => {
    const first = buildTransactionScenario({ seed: 1, action: "deposit" });
    const second = buildTransactionScenario({ seed: 2, action: "deposit" });
    const withdraw = buildTransactionScenario({ seed: 1, action: "withdraw" });

    expect(second.walletAddress).not.toBe(first.walletAddress);
    expect(second.txHash).not.toBe(first.txHash);
    expect(withdraw.walletAddress).toBe(first.walletAddress);
    expect(withdraw.txHash).not.toBe(first.txHash);
  });

  it("produces addresses the Stellar SDK accepts", () => {
    for (const scenario of buildTransactionScenarioMatrix(99)) {
      expect(StrKey.isValidEd25519PublicKey(scenario.walletAddress)).toBe(true);
      expect(StrKey.isValidContract(scenario.contractId)).toBe(true);
    }
    expect(SCENARIO_VAULT_CONTRACT_ID).not.toBe(SCENARIO_ZAP_CONTRACT_ID);
  });

  it("models a confirmed deposit end to end, including the persisted row", () => {
    const scenario = buildTransactionScenario({ seed: 5, action: "zap", amountStroops: "25000000" });

    expect(scenario.phases).toEqual(["building", "simulating", "waiting_for_wallet", "submitting", "polling", "success"]);
    expect(scenario.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scenario.ledger).toBeGreaterThanOrEqual(1_000_000);
    expect(scenario.finalStatus).toBe("confirmed");
    expect(scenario.contractId).toBe(SCENARIO_ZAP_CONTRACT_ID);
    expect(scenario.serverRecord).toMatchObject({
      walletAddress: scenario.walletAddress,
      vaultId: SCENARIO_VAULT_CONTRACT_ID,
      action: "DEPOSIT",
      amount: 2.5,
      txHash: scenario.txHash,
      timestamp: scenario.timeline[scenario.timeline.length - 1].at,
    });
    expect(scenario.serverRecord!.shares).toBeCloseTo(2.5 / scenario.serverRecord!.sharePriceAtTx, 6);
  });

  it("spaces the timeline by a fixed step from the start time", () => {
    const scenario = buildTransactionScenario({ seed: 3, action: "withdraw" });
    const start = Date.parse(SCENARIO_BASE_TIME);

    scenario.timeline.forEach(({ at }, index) => {
      expect(Date.parse(at)).toBe(start + index * SCENARIO_PHASE_STEP_MS);
    });
  });

  it("fails a contract_error scenario at simulation with a decodable contract error", () => {
    const scenario = buildTransactionScenario({
      seed: 8,
      action: "withdraw",
      outcome: "contract_error",
      contractErrorCode: 4,
    });

    expect(scenario.phases).toEqual(["building", "simulating", "failure"]);
    expect(scenario.txHash).toBeNull();
    expect(scenario.serverRecord).toBeNull();
    expect(scenario.finalStatus).toBe("failed");
    expect(decodeScError(scenario.scError, scenario.contractNamespace)).toMatchObject({
      code: "CONTRACT_ERROR",
      errorName: "InsufficientShares",
    });
  });

  it("keeps a timed-out submission's hash but reports unknown finality", () => {
    const scenario = buildTransactionScenario({ seed: 8, action: "deposit", outcome: "submission_timeout" });

    expect(scenario.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scenario.ledger).toBeNull();
    expect(scenario.finalStatus).toBe("unknown");
    expect(scenario.phases).toContain("recovering");
    expect(scenario.serverRecord).toBeNull();
  });

  it("never submits a wallet-rejected transaction", () => {
    const scenario = buildTransactionScenario({ seed: 8, action: "zap", outcome: "wallet_rejected" });

    expect(scenario.phases[scenario.phases.length - 2]).toBe("waiting_for_wallet");
    expect(scenario.txHash).toBeNull();
    expect(scenario.finalStatus).toBe("failed");
  });

  it("rejects invalid specs with typed error codes", () => {
    expect(scenarioErrorCode({ seed: -1, action: "deposit" })).toBe("SCENARIO_INVALID_SEED");
    expect(scenarioErrorCode({ seed: 1.5, action: "deposit" })).toBe("SCENARIO_INVALID_SEED");
    expect(scenarioErrorCode({ seed: 1, action: "stake" as never })).toBe("SCENARIO_UNKNOWN_ACTION");
    expect(scenarioErrorCode({ seed: 1, action: "deposit", outcome: "lost" as never })).toBe(
      "SCENARIO_UNKNOWN_OUTCOME",
    );
    expect(scenarioErrorCode({ seed: 1, action: "deposit", amountStroops: "0" })).toBe("SCENARIO_INVALID_AMOUNT");
    expect(scenarioErrorCode({ seed: 1, action: "deposit", amountStroops: "1.5" })).toBe("SCENARIO_INVALID_AMOUNT");
    expect(scenarioErrorCode({ seed: 1, action: "deposit", startedAt: "yesterday" })).toBe(
      "SCENARIO_INVALID_START_TIME",
    );
    expect(scenarioErrorCode({ seed: 1, action: "withdraw", outcome: "contract_error" })).toBe(
      "SCENARIO_MISSING_CONTRACT_ERROR",
    );
    expect(
      scenarioErrorCode({ seed: 1, action: "withdraw", outcome: "contract_error", contractErrorCode: 999 }),
    ).toBe("SCENARIO_UNKNOWN_CONTRACT_ERROR");
    expect(scenarioErrorCode({ seed: 1, action: "deposit", contractErrorCode: 4 })).toBe(
      "SCENARIO_UNEXPECTED_CONTRACT_ERROR",
    );
  });
});

describe("buildTransactionScenarioMatrix", () => {
  it("covers every action and outcome once", () => {
    const ids = buildTransactionScenarioMatrix(1).map((scenario) => scenario.id);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids).toContain("zap-contract_error-1");
  });
});
