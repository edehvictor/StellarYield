import { describe, it, expect } from "vitest";
import { computeSignerQuorumProgress } from "./signerQuorum";

const S1 = "SIGNER_ONE";
const S2 = "SIGNER_TWO";
const S3 = "SIGNER_THREE";

function tx(
  signatures: { publicKey: string; signedAt: number }[],
  threshold: number,
) {
  return {
    id: "tx-1",
    description: "test",
    method: "set_fee",
    args: [],
    xdr: "AAAA",
    signatures,
    threshold,
    createdAt: Date.now(),
    createdBy: S1,
    status: "pending" as const,
  };
}

describe("computeSignerQuorumProgress (#1310)", () => {
  it("computes zero progress when no signatures", () => {
    const progress = computeSignerQuorumProgress(tx([], 3), {
      signers: [S1, S2, S3],
    });
    expect(progress).toMatchObject({
      signed: 0,
      required: 3,
      remaining: 3,
      progressPct: 0,
      met: false,
    });
    expect(progress.perSigner.every((s) => !s.signed)).toBe(true);
  });

  it("computes partial progress", () => {
    const progress = computeSignerQuorumProgress(
      tx(
        [
          { publicKey: S1, signedAt: 1 },
          { publicKey: S2, signedAt: 2 },
        ],
        3,
      ),
      { signers: [S1, S2, S3] },
    );
    expect(progress.signed).toBe(2);
    expect(progress.remaining).toBe(1);
    expect(progress.progressPct).toBe(67);
    expect(progress.met).toBe(false);
  });

  it("marks met when threshold reached", () => {
    const progress = computeSignerQuorumProgress(
      tx(
        [
          { publicKey: S1, signedAt: 1 },
          { publicKey: S2, signedAt: 2 },
          { publicKey: S3, signedAt: 3 },
        ],
        3,
      ),
      { signers: [S1, S2, S3] },
    );
    expect(progress.met).toBe(true);
    expect(progress.remaining).toBe(0);
    expect(progress.progressPct).toBe(100);
    expect(progress.perSigner.every((s) => s.signed)).toBe(true);
  });

  it("ignores signatures from unknown signers when config has signers", () => {
    const progress = computeSignerQuorumProgress(
      tx(
        [
          { publicKey: S1, signedAt: 1 },
          { publicKey: "STRANGER", signedAt: 2 },
        ],
        2,
      ),
      { signers: [S1, S2, S3] },
    );
    expect(progress.signed).toBe(1);
    expect(progress.met).toBe(false);
  });

  it("falls back to counting any signature when config.signers is empty", () => {
    const progress = computeSignerQuorumProgress(
      tx(
        [
          { publicKey: S1, signedAt: 1 },
          { publicKey: S2, signedAt: 2 },
        ],
        2,
      ),
      { signers: [] },
    );
    expect(progress.signed).toBe(2);
    expect(progress.met).toBe(true);
  });
});
