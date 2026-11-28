import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isValidPendingTransaction,
  parseStoredTransactions,
  parseStoredConfig,
  parseStoredAuditRecords,
  validateGovernanceConfigInput,
  useGovernanceStore,
} from "./useGovernanceStore";
import { GovernanceExecutionError } from "./governanceOperation";
import {
  computeGovernanceConfigFingerprint,
  GovernanceConfigSnapshotError,
} from "../../../../shared/types/governanceConfigSnapshot";
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

const signerA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const signerB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const signerC = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function config(overrides: Partial<GovernanceConfig> = {}): GovernanceConfig {
  return {
    signers: [signerA, signerB],
    threshold: 2,
    contractId,
    ...overrides,
  };
}

function proposal(configFingerprint: string | undefined): PendingTransaction {
  return {
    id: "proposal-1",
    configFingerprint,
    description: "Set keeper fee",
    method: "set_keeper_fee",
    args: ["50"],
    xdr: "mock-xdr",
    signatures: [],
    threshold: 2,
    createdAt: Date.now(),
    createdBy: signerA,
    status: "pending",
  };
}

describe("useGovernanceStore configuration binding (#1894)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it("normal operation: stamps new proposals and accepts signatures under the current config", () => {
    const { result } = renderHook(() => useGovernanceStore());

    act(() => {
      result.current.updateConfig(config(), signerA);
    });

    const fingerprint = computeGovernanceConfigFingerprint(
      result.current.config,
    ).fingerprint;
    expect(result.current.configFingerprint).toBe(fingerprint);

    act(() => {
      result.current.addTransaction(proposal(undefined));
    });

    expect(result.current.transactions[0].configFingerprint).toBe(fingerprint);

    act(() => {
      result.current.addSignature("proposal-1", signerA);
    });

    expect(result.current.transactions[0].signatures).toHaveLength(1);
    expect(result.current.transactions[0].status).toBe("pending");
  });

  it("failure: rejects signing stale work and preserves transactions/signatures", () => {
    const { result } = renderHook(() => useGovernanceStore());

    act(() => {
      result.current.updateConfig(config(), signerA);
    });
    const originalFingerprint = result.current.configFingerprint;

    act(() => {
      result.current.addTransaction(proposal(originalFingerprint));
    });
    act(() => {
      result.current.addSignature("proposal-1", signerA);
    });

    const before = result.current.transactions;
    const persistedBefore = localStorage.getItem("stellar_yield_governance_txns");

    act(() => {
      result.current.updateConfig(
        config({ signers: [signerA, signerB, signerC], threshold: 3 }),
        signerA,
      );
    });

    let error: unknown;
    act(() => {
      try {
        result.current.addSignature("proposal-1", signerB);
      } catch (caught) {
        error = caught;
      }
    });

    expect(error).toBeInstanceOf(GovernanceConfigSnapshotError);
    expect((error as GovernanceConfigSnapshotError).code).toBe(
      "STALE_GOVERNANCE_CONFIG",
    );
    expect(result.current.transactions).toEqual(before);
    expect(localStorage.getItem("stellar_yield_governance_txns")).toBe(
      persistedBefore,
    );
  });

  it("failure: rejects execution of stale work until it is explicitly refreshed", () => {
    const { result } = renderHook(() => useGovernanceStore());

    act(() => {
      result.current.updateConfig(config(), signerA);
    });
    act(() => {
      result.current.addTransaction(proposal(result.current.configFingerprint));
    });
    act(() => {
      result.current.addSignature("proposal-1", signerA);
    });
    act(() => {
      result.current.addSignature("proposal-1", signerB);
    });
    expect(result.current.transactions[0].status).toBe("ready");

    act(() => {
      result.current.updateConfig(
        config({ signers: [signerA, signerB, signerC], threshold: 2 }),
        signerA,
      );
    });

    let error: unknown;
    act(() => {
      try {
        result.current.markExecuted("proposal-1");
      } catch (caught) {
        error = caught;
      }
    });

    expect(error).toBeInstanceOf(GovernanceConfigSnapshotError);
    expect(result.current.transactions[0].status).toBe("ready");
    expect(result.current.transactions[0].signatures).toHaveLength(2);
  });

  it("safe retry: refresh re-binds existing signatures and then signing/execution succeed", () => {
    const { result } = renderHook(() => useGovernanceStore());

    act(() => {
      result.current.updateConfig(config(), signerA);
    });
    act(() => {
      result.current.addTransaction(proposal(result.current.configFingerprint));
    });
    act(() => {
      result.current.addSignature("proposal-1", signerA);
    });

    act(() => {
      result.current.updateConfig(
        config({ signers: [signerA, signerB, signerC], threshold: 3 }),
        signerA,
      );
    });

    act(() => {
      result.current.refreshTransactionConfig("proposal-1");
    });

    expect(result.current.transactions[0].configFingerprint).toBe(
      result.current.configFingerprint,
    );
    expect(result.current.transactions[0].signatures).toHaveLength(1);

    act(() => {
      result.current.addSignature("proposal-1", signerB);
    });
    act(() => {
      result.current.addSignature("proposal-1", signerC);
    });
    expect(result.current.transactions[0].status).toBe("ready");

    act(() => {
      result.current.markExecuted("proposal-1");
    });
    expect(result.current.transactions[0].status).toBe("executed");
  });

  it("preserves the previous configuration when validation fails", () => {
    const { result } = renderHook(() => useGovernanceStore());

    act(() => {
      result.current.updateConfig(config(), signerA);
    });
    const before = result.current.config;
    const persistedBefore = localStorage.getItem("stellar_yield_governance_config");

    expect(() =>
      act(() => {
        result.current.updateConfig(
          config({ signers: [signerA, signerA], threshold: 2 }),
          signerA,
        );
      }),
    ).toThrow(/Invalid governance configuration/);

    expect(result.current.config).toEqual(before);
    expect(localStorage.getItem("stellar_yield_governance_config")).toBe(
      persistedBefore,
    );
  });
});
