import { describe, it, expect, beforeEach } from "vitest";
import {
  isValidPendingTransaction,
  parseStoredTransactions,
  parseStoredConfig,
  parseStoredAuditRecords,
  validateGovernanceConfigInput,
} from "./useGovernanceStore";
import { GovernanceExecutionError } from "./governanceOperation";
import type { GovernanceConfig, PendingTransaction } from "./types";

const VALID_TX: PendingTransaction = {
  id: "tx-1",
  description: "Emergency pause",
  method: "emergency_pause",
  args: [],
  xdr: "AAAA...",
  signatures: [{ publicKey: "GABC", signedAt: 1700000000000 }],
  threshold: 2,
  createdAt: 1700000000000,
  createdBy: "GABC",
  status: "pending",
};

const FALLBACK_CONFIG: GovernanceConfig = {
  signers: ["GABC", "GDEF"],
  threshold: 2,
  contractId: "C123",
};

describe("governance store boundary validation (#1897)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("accepts valid persisted transactions, config, and audit records", () => {
    expect(isValidPendingTransaction(VALID_TX)).toBe(true);
    expect(parseStoredTransactions([VALID_TX])).toEqual([VALID_TX]);
    expect(parseStoredConfig(FALLBACK_CONFIG, FALLBACK_CONFIG)).toEqual(
      FALLBACK_CONFIG,
    );
    expect(
      parseStoredAuditRecords([
        {
          id: "audit-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "GABC",
          addedSigners: ["GDEF"],
          removedSigners: [],
          previousThreshold: 1,
          nextThreshold: 2,
        },
      ]),
    ).toHaveLength(1);
  });

  it("drops malformed persisted entries without crashing", () => {
    expect(parseStoredTransactions({ not: "an-array" })).toEqual([]);
    expect(
      parseStoredTransactions([
        null,
        { id: "bad-1", signatures: "not-an-array" },
        { ...VALID_TX, threshold: 0 },
        { ...VALID_TX, status: "unknown" },
        VALID_TX,
      ]),
    ).toEqual([VALID_TX]);

    expect(
      parseStoredConfig({ signers: ["", 123], threshold: 0 }, FALLBACK_CONFIG),
    ).toEqual(FALLBACK_CONFIG);
    expect(parseStoredAuditRecords("corrupt")).toEqual([]);
  });

  it("rejects malformed governance config updates with a typed error and allows safe retry", () => {
    expect(() =>
      validateGovernanceConfigInput(
        { signers: ["GABC", "GABC"], threshold: 2, contractId: "C123" },
        "GABC",
      ),
    ).toThrowError(GovernanceExecutionError);

    try {
      validateGovernanceConfigInput(
        { signers: ["GABC"], threshold: 3, contractId: "C123" },
        "GABC",
      );
    } catch (err) {
      expect(err).toBeInstanceOf(GovernanceExecutionError);
      expect((err as GovernanceExecutionError).code).toBe("INVALID_INPUT");
      expect((err as GovernanceExecutionError).field).toBe("threshold");
    }

    // Safe retry with corrected input succeeds.
    expect(() =>
      validateGovernanceConfigInput(FALLBACK_CONFIG, "GABC"),
    ).not.toThrow();
  });
});
