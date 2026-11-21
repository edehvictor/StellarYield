import { describe, it, expect } from "vitest";
import {
  GovernanceValidationError,
  parseStoredAuditRecords,
  parseStoredConfig,
  parseStoredTransactions,
  validateGovernanceConfigInput,
  validatePendingTransactionInput,
  validateSignatureInput,
} from "./governanceValidation";
import type { GovernanceConfig, PendingTransaction } from "./types";

const FALLBACK_CONFIG: GovernanceConfig = {
  signers: [],
  threshold: 3,
  contractId: "CDEFAULT",
};

function makeTx(overrides: Partial<PendingTransaction> = {}): PendingTransaction {
  return {
    id: "tx-1",
    description: "Pause vault",
    method: "emergency_pause",
    args: [],
    xdr: "AAAA...",
    signatures: [{ publicKey: "GABC", signedAt: 1000 }],
    threshold: 2,
    createdAt: 1000,
    createdBy: "GABC",
    status: "pending",
    ...overrides,
  };
}

describe("governanceValidation (#1897)", () => {
  it("sanitizes corrupted localStorage payloads without throwing", () => {
    expect(parseStoredTransactions("corrupt")).toEqual([]);
    expect(parseStoredTransactions([null, { id: "bad" }, makeTx()])).toHaveLength(1);

    expect(parseStoredConfig(null, FALLBACK_CONFIG)).toEqual(FALLBACK_CONFIG);
    expect(
      parseStoredConfig(
        { signers: ["GABC", 123], threshold: 1, contractId: "C1" },
        FALLBACK_CONFIG,
      ),
    ).toEqual(FALLBACK_CONFIG);
    expect(
      parseStoredConfig(
        { signers: [" GABC ", "GDEF"], threshold: 2, contractId: "C1" },
        FALLBACK_CONFIG,
      ),
    ).toEqual({
      signers: ["GABC", "GDEF"],
      threshold: 2,
      contractId: "C1",
    });

    expect(parseStoredAuditRecords({ not: "an-array" })).toEqual([]);
  });

  it("rejects malformed governance config with a typed error and allows safe retry", () => {
    expect(() =>
      validateGovernanceConfigInput({
        signers: ["GABC", "GABC"],
        threshold: 1,
        contractId: "C1",
      }),
    ).toThrowError(GovernanceValidationError);

    expect(() =>
      validateGovernanceConfigInput({
        signers: ["GABC"],
        threshold: 2,
        contractId: "C1",
      }),
    ).toThrowError(GovernanceValidationError);

    expect(() =>
      validateGovernanceConfigInput({
        signers: ["GABC"],
        threshold: 0,
        contractId: "C1",
      }),
    ).toThrowError(GovernanceValidationError);

    expect(
      validateGovernanceConfigInput({
        signers: [" GABC ", "GDEF"],
        threshold: 2,
        contractId: " C1 ",
      }),
    ).toEqual({
      signers: ["GABC", "GDEF"],
      threshold: 2,
      contractId: "C1",
    });
  });

  it("rejects malformed proposal transactions and signatures", () => {
    expect(() =>
      validatePendingTransactionInput(makeTx({ xdr: "   " })),
    ).toThrowError(GovernanceValidationError);

    expect(() =>
      validatePendingTransactionInput(makeTx({ threshold: 0 })),
    ).toThrowError(GovernanceValidationError);

    expect(() => validateSignatureInput("tx-1", "   ")).toThrowError(
      GovernanceValidationError,
    );

    expect(validatePendingTransactionInput(makeTx()).id).toBe("tx-1");
    expect(validateSignatureInput(" tx-1 ", " GDEF ")).toEqual({
      txId: "tx-1",
      publicKey: "GDEF",
    });
  });
});
