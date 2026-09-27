/**
 * contractPanicDecoding.test.ts
 *
 * The failure modal must render copy decoded from the structured `ScError` in
 * the simulation's diagnostic events (#1339), per contract, rather than from
 * the error string.
 */
import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { decodeTransactionError } from "./errorDecoder";
import { decodeContractPanic } from "../../../shared/types/contractPanic";

function errorEvent(scError: xdr.ScError): xdr.DiagnosticEvent {
    return new xdr.DiagnosticEvent({
        inSuccessfulContractCall: false,
        event: new xdr.ContractEvent({
            ext: new xdr.ExtensionPoint(0),
            contractId: null,
            type: xdr.ContractEventType.diagnostic(),
            body: new xdr.ContractEventBody(
                0,
                new xdr.ContractEventV0({
                    topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(scError)],
                    data: xdr.ScVal.scvString("escalating error to panic"),
                }),
            ),
        }),
    });
}

describe("decodeTransactionError with a decoded contract panic", () => {
    it("renders the zap's own error for its code instead of the vault's", () => {
        const panic = decodeContractPanic([errorEvent(xdr.ScError.sceContract(5))], "zap");

        const decoded = decodeTransactionError(
            "Contract Execution Error [5 Unauthorized]: Caller is unauthorized for this operation",
            panic,
        );

        expect(decoded.title).toBe("Slippage Exceeded");
        expect(decoded.code).toBe(5);
    });

    it("decodes the SDK-formatted simulation message that the string parser cannot read", () => {
        const raw = "Contract Execution Error [4 InsufficientShares]: Insufficient shares available for operation";
        const panic = decodeContractPanic([errorEvent(xdr.ScError.sceContract(4))], "vault");

        const decoded = decodeTransactionError(raw, panic);

        expect(decoded.title).toBe("Insufficient Shares");
        expect(decoded.suggestion).toBe("Reduce the withdrawal amount or wait for more shares to accrue.");
        expect(decoded.raw).toBe(raw);
    });

    it("explains an untyped contract panic (Wasm trap)", () => {
        const panic = decodeContractPanic(
            [errorEvent(xdr.ScError.sceWasmVm(xdr.ScErrorCode.scecInvalidAction()))],
            "zap",
        );

        const decoded = decodeTransactionError("HostError: Error(WasmVm, InvalidAction)", panic);

        expect(decoded.title).toBe("Contract Stopped Unexpectedly");
        expect(decoded.code).toBeUndefined();
    });

    it("keeps the numeric code for a contract error the app does not know", () => {
        const panic = decodeContractPanic([errorEvent(xdr.ScError.sceContract(42))], "zap");

        const decoded = decodeTransactionError("HostError: Error(Contract, #42)", panic);

        expect(decoded.title).toBe("Contract Rejected the Transaction");
        expect(decoded.code).toBe(42);
    });

    it("falls back to the legacy decoder when the events carry no structured error", () => {
        const panic = decodeContractPanic([], "vault");

        expect(decodeTransactionError("Error(Contract, #7)", panic).title).toBe("Vault Paused");
        expect(decodeTransactionError("Error(Contract, #7)").title).toBe("Vault Paused");
    });
});
