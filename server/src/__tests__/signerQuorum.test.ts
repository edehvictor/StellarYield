import request from "supertest";
import express from "express";
import governanceRouter from "../routes/governance";
import { computeSignerQuorumProgress } from "../services/signerQuorumService";

const app = express();
app.use(express.json());
app.use("/api/governance", governanceRouter);

const S1 = "SIGNER_ONE";
const S2 = "SIGNER_TWO";
const S3 = "SIGNER_THREE";
const S4 = "SIGNER_FOUR";

describe("computeSignerQuorumProgress (#1310)", () => {
  it("returns zeroed progress when no signatures", () => {
    const progress = computeSignerQuorumProgress({
      signers: [S1, S2, S3],
      signatures: [],
      threshold: 3,
    });
    expect(progress).toEqual({
      signed: 0,
      required: 3,
      remaining: 3,
      progressPct: 0,
      met: false,
      perSigner: [
        { address: S1, signed: false },
        { address: S2, signed: false },
        { address: S3, signed: false },
      ],
    });
  });

  it("counts unique known signatures only", () => {
    const progress = computeSignerQuorumProgress({
      signers: [S1, S2, S3],
      signatures: [S1, S1, S2, "UNKNOWN"],
      threshold: 3,
    });
    expect(progress.signed).toBe(2);
    expect(progress.remaining).toBe(1);
    expect(progress.progressPct).toBe(67);
    expect(progress.met).toBe(false);
  });

  it("marks met when signed >= threshold", () => {
    const progress = computeSignerQuorumProgress({
      signers: [S1, S2, S3],
      signatures: [S1, S2, S3],
      threshold: 3,
    });
    expect(progress.signed).toBe(3);
    expect(progress.remaining).toBe(0);
    expect(progress.progressPct).toBe(100);
    expect(progress.met).toBe(true);
    expect(progress.perSigner.every((s) => s.signed)).toBe(true);
  });

  it("clamps threshold to at least 1", () => {
    const progress = computeSignerQuorumProgress({
      signers: [S1],
      signatures: [S1],
      threshold: 0,
    });
    expect(progress.required).toBe(1);
    expect(progress.met).toBe(true);
  });

  it("handles empty signers list", () => {
    const progress = computeSignerQuorumProgress({
      signers: [],
      signatures: [S1],
      threshold: 2,
    });
    expect(progress.signed).toBe(0);
    expect(progress.remaining).toBe(2);
    expect(progress.met).toBe(false);
    expect(progress.perSigner).toEqual([]);
  });

  it("tracks per-signer status independently", () => {
    const progress = computeSignerQuorumProgress({
      signers: [S1, S2, S3, S4],
      signatures: [S2, S4],
      threshold: 3,
    });
    expect(progress.perSigner).toEqual([
      { address: S1, signed: false },
      { address: S2, signed: true },
      { address: S3, signed: false },
      { address: S4, signed: true },
    ]);
    expect(progress.signed).toBe(2);
    expect(progress.met).toBe(false);
  });
});

describe("POST /api/governance/quorum-progress (#1310)", () => {
  it("returns progress for a valid payload", async () => {
    const res = await request(app)
      .post("/api/governance/quorum-progress")
      .send({ signers: [S1, S2, S3], signatures: [S1], threshold: 2 })
      .expect(200);

    expect(res.body).toMatchObject({
      signed: 1,
      required: 2,
      remaining: 1,
      progressPct: 50,
      met: false,
    });
    expect(res.body.perSigner).toHaveLength(3);
    expect(res.body.perSigner[0]).toEqual({ address: S1, signed: true });
  });

  it("rejects non-array signers", async () => {
    const res = await request(app)
      .post("/api/governance/quorum-progress")
      .send({ signers: "nope", signatures: [], threshold: 1 })
      .expect(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  it("rejects non-array signatures", async () => {
    await request(app)
      .post("/api/governance/quorum-progress")
      .send({ signers: [], signatures: 42, threshold: 1 })
      .expect(400);
  });

  it("rejects non-numeric threshold", async () => {
    await request(app)
      .post("/api/governance/quorum-progress")
      .send({ signers: [], signatures: [], threshold: "two" })
      .expect(400);
  });
});
