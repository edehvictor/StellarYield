import { describe, expect, it } from "vitest";
import {
  assertGovernanceConfigFingerprint,
  computeGovernanceConfigFingerprint,
  GovernanceConfigSnapshotError,
  validateGovernanceConfigSnapshot,
  verifyGovernanceConfigFingerprint,
  type GovernanceConfigSnapshot,
} from "./governanceConfigSnapshot";

const signerA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const signerB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const signerC = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function snapshot(overrides: Partial<GovernanceConfigSnapshot> = {}): GovernanceConfigSnapshot {
  return {
    signers: [signerA, signerB, signerC],
    threshold: 2,
    contractId,
    ...overrides,
  };
}

describe("governance configuration fingerprints (#1894)", () => {
  it("normal operation: equivalent configurations produce the same immutable fingerprint", () => {
    const first = computeGovernanceConfigFingerprint(snapshot());
    const reordered = computeGovernanceConfigFingerprint({
      signers: [signerC.trim(), signerA, signerB, signerB],
      threshold: 2,
      contractId: `  ${contractId}  `,
    });

    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered.fingerprint).toBe(first.fingerprint);
    expect(reordered.snapshot.signers).toEqual([signerA, signerB, signerC]);
    expect(
      verifyGovernanceConfigFingerprint(reordered.snapshot, first.fingerprint),
    ).toMatchObject({
      valid: true,
      status: "valid",
      code: "GOVERNANCE_CONFIG_CURRENT",
    });
  });

  it("failure: a changed signer set, threshold or contract is detected as stale", () => {
    const original = computeGovernanceConfigFingerprint(snapshot());
    const newSignerSet = snapshot({ signers: [signerA, signerB] });
    const newThreshold = snapshot({ threshold: 3 });
    const newContract = snapshot({ contractId: `${contractId}X` });

    for (const next of [newSignerSet, newThreshold, newContract]) {
      const verification = verifyGovernanceConfigFingerprint(
        next,
        original.fingerprint,
      );
      expect(verification.valid).toBe(false);
      expect(verification.status).toBe("stale");
      expect(verification.code).toBe("STALE_GOVERNANCE_CONFIG");
      expect(verification.actualFingerprint).toBe(original.fingerprint);
      expect(verification.expectedFingerprint).not.toBe(original.fingerprint);
    }
  });

  it("failure: assert throws a typed recoverable error without changing the snapshot", () => {
    const original = snapshot();
    const originalFingerprint = computeGovernanceConfigFingerprint(original).fingerprint;
    const next = snapshot({ threshold: 3 });

    let error: unknown;
    try {
      assertGovernanceConfigFingerprint(next, originalFingerprint);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GovernanceConfigSnapshotError);
    expect((error as GovernanceConfigSnapshotError).code).toBe(
      "STALE_GOVERNANCE_CONFIG",
    );
    expect(original).toEqual(snapshot());
  });

  it("failure: a missing or malformed fingerprint is invalid rather than accepted", () => {
    const current = computeGovernanceConfigFingerprint(snapshot());

    for (const claim of [undefined, "", "not-a-digest", "0x1234"]) {
      const verification = verifyGovernanceConfigFingerprint(
        current.snapshot,
        claim,
      );
      expect(verification.valid).toBe(false);
      expect(verification.status).toBe("invalid");
      expect(verification.code).toBe("INVALID_GOVERNANCE_CONFIG");
    }
  });

  it("safe retry: refreshing the fingerprint for the new configuration succeeds", () => {
    const original = computeGovernanceConfigFingerprint(snapshot());
    const next = snapshot({ signers: [signerA, signerB], threshold: 2 });
    const stale = verifyGovernanceConfigFingerprint(next, original.fingerprint);
    expect(stale.valid).toBe(false);

    const refreshed = computeGovernanceConfigFingerprint(next);
    const retried = verifyGovernanceConfigFingerprint(
      next,
      refreshed.fingerprint,
    );
    expect(retried.valid).toBe(true);
    expect(retried.code).toBe("GOVERNANCE_CONFIG_CURRENT");
  });

  it("validates configuration shape before it can be persisted", () => {
    expect(validateGovernanceConfigSnapshot(snapshot()).valid).toBe(true);

    const duplicate = validateGovernanceConfigSnapshot(
      snapshot({ signers: [signerA, signerA, signerB] }),
    );
    expect(duplicate.valid).toBe(false);
    expect(duplicate.issues.some((issue) => issue.field === "signers[1]")).toBe(true);

    const impossibleThreshold = validateGovernanceConfigSnapshot(
      snapshot({ signers: [signerA], threshold: 2 }),
    );
    expect(impossibleThreshold.valid).toBe(false);

    const badThreshold = validateGovernanceConfigSnapshot(
      snapshot({ threshold: 0 }),
    );
    expect(badThreshold.valid).toBe(false);
  });
});
