/**
 * The shared end-to-end transaction scenarios (#1342) must drive the client's
 * lifecycle model and failure copy without adaptation.
 */
import { describe, it, expect } from "vitest";
import {
  buildTransactionScenario,
  buildTransactionScenarioMatrix,
} from "../../../shared/test-fixtures/transactionScenarios";
import { decodeScError } from "../../../shared/types/contractPanic";
import { TX_PHASE_PIPELINE, isTerminalPhase, type TxPhase } from "./transactionPhase";
import { decodeTransactionError } from "../utils/errorDecoder";

describe("transaction scenario fixtures on the client", () => {
    it("uses only client lifecycle phases and ends in the matching terminal phase", () => {
        for (const scenario of buildTransactionScenarioMatrix(2026)) {
            const phases: TxPhase[] = scenario.phases;
            const last = phases[phases.length - 1];

            expect(isTerminalPhase(last)).toBe(true);
            expect(last).toBe(scenario.outcome === "confirmed" ? "success" : "failure");
            for (const phase of phases.slice(0, -1)) {
                expect([...TX_PHASE_PIPELINE, "recovering"]).toContain(phase);
            }
        }
    });

    it("renders the contract's own failure copy for a contract_error scenario", () => {
        const scenario = buildTransactionScenario({
            seed: 11,
            action: "zap",
            outcome: "contract_error",
            contractErrorCode: 5,
        });
        const panic = decodeScError(scenario.scError, scenario.contractNamespace);

        const decoded = decodeTransactionError("simulation failed", panic);

        expect(decoded.title).toBe("Slippage Exceeded");
        expect(decoded.code).toBe(5);
    });

    it("gives every scenario of a matrix a stable, unique id", () => {
        const ids = buildTransactionScenarioMatrix(3).map((scenario) => scenario.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(buildTransactionScenarioMatrix(3).map((scenario) => scenario.id)).toEqual(ids);
    });
});
