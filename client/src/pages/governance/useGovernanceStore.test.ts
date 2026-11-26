import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGovernanceStore } from "./useGovernanceStore";
import {
  computeGovernanceConfigFingerprint,
  GovernanceConfigSnapshotError,
} from "../../../../shared/types/governanceConfigSnapshot";
import type { GovernanceConfig, PendingTransaction } from "./types";

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

beforeEach(() => {
  localStorage.clear();
});

describe("useGovernanceStore configuration binding (#1894)", () => {
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
