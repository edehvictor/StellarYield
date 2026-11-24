import request from "supertest";
import express from "express";
import governanceRouter from "../routes/governance";
import {
  computeGovernanceConfigFingerprint,
  type GovernanceConfigSnapshot,
} from "../../../shared/types/governanceConfigSnapshot";

const app = express();
app.use(express.json());
app.use("/api/governance", governanceRouter);

const signerA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const signerB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const signerC = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const baseline = {
  yieldPct: 8,
  exposurePct: 40,
  feeRatePct: 2,
  tvlUsd: 10_000_000,
  riskScore: 50,
  vaultCount: 3,
};

function config(overrides: Partial<GovernanceConfigSnapshot> = {}): GovernanceConfigSnapshot {
  return {
    signers: [signerA, signerB, signerC],
    threshold: 2,
    contractId,
    ...overrides,
  };
}

function forecastBody(
  configSnapshot: GovernanceConfigSnapshot,
  expectedConfigFingerprint: string,
) {
  return {
    proposalType: "fee_change",
    parameters: { feeRatePct: 3 },
    baseline,
    configSnapshot,
    expectedConfigFingerprint,
  };
}

describe("governance configuration snapshot API (#1894)", () => {
  it("normal operation: returns the immutable fingerprint and binds forecast/quorum work", async () => {
    const snapshotResponse = await request(app)
      .post("/api/governance/config-snapshot")
      .send(config())
      .expect(200);

    expect(snapshotResponse.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const fingerprint = snapshotResponse.body.fingerprint as string;

    const forecast = await request(app)
      .post("/api/governance/forecast")
      .send(forecastBody(snapshotResponse.body.snapshot, fingerprint))
      .expect(200);

    expect(forecast.body.configFingerprint).toBe(fingerprint);
    expect(forecast.body.configSnapshot).toEqual(snapshotResponse.body.snapshot);
    expect(forecast.body.forecast.yieldDeltaPct).toBeLessThan(0);

    const quorum = await request(app)
      .post("/api/governance/quorum-progress")
      .send({
        signers: config().signers,
        signatures: [signerA],
        threshold: 2,
        contractId,
        expectedConfigFingerprint: fingerprint,
      })
      .expect(200);

    expect(quorum.body.configFingerprint).toBe(fingerprint);
    expect(quorum.body.signed).toBe(1);
  });

  it("failure: rejects stale work before forecasting or computing quorum", async () => {
    const originalFingerprint = computeGovernanceConfigFingerprint(config()).fingerprint;
    const changed = config({ threshold: 3 });
    const changedFingerprint = computeGovernanceConfigFingerprint(changed).fingerprint;

    const staleForecast = await request(app)
      .post("/api/governance/forecast")
      .send(forecastBody(changed, originalFingerprint))
      .expect(409);

    expect(staleForecast.body.error).toBe("STALE_GOVERNANCE_CONFIG");
    expect(staleForecast.body.recoverable).toBe(true);
    expect(staleForecast.body.details.expectedFingerprint).toBe(changedFingerprint);
    expect(staleForecast.body.details.providedFingerprint).toBe(originalFingerprint);
    expect(staleForecast.body).not.toHaveProperty("forecast");

    const staleQuorum = await request(app)
      .post("/api/governance/quorum-progress")
      .send({
        signers: changed.signers,
        signatures: [signerA],
        threshold: changed.threshold,
        contractId,
        expectedConfigFingerprint: originalFingerprint,
      })
      .expect(409);

    expect(staleQuorum.body.error).toBe("STALE_GOVERNANCE_CONFIG");
    expect(staleQuorum.body).not.toHaveProperty("signed");
  });

  it("failure: rejects malformed snapshots and incomplete bindings", async () => {
    const invalidConfig = await request(app)
      .post("/api/governance/config-snapshot")
      .send({ signers: [signerA, signerA], threshold: 2, contractId })
      .expect(400);

    expect(invalidConfig.body.error).toBe("INVALID_GOVERNANCE_CONFIG");

    const incomplete = await request(app)
      .post("/api/governance/forecast")
      .send({
        proposalType: "fee_change",
        parameters: { feeRatePct: 3 },
        baseline,
        configSnapshot: config(),
      })
      .expect(400);

    expect(incomplete.body.error).toBe("INVALID_GOVERNANCE_CONFIG");
  });

  it("safe retry: refreshed fingerprint succeeds and leaves prior results untouched", async () => {
    const original = computeGovernanceConfigFingerprint(config()).fingerprint;
    const changed = config({ signers: [signerA, signerB], threshold: 2 });

    await request(app)
      .post("/api/governance/forecast")
      .send(forecastBody(changed, original))
      .expect(409);

    const refreshed = await request(app)
      .post("/api/governance/config-snapshot")
      .send(changed)
      .expect(200);

    expect(refreshed.body.fingerprint).not.toBe(original);

    const retried = await request(app)
      .post("/api/governance/forecast")
      .send(forecastBody(changed, refreshed.body.fingerprint))
      .expect(200);

    expect(retried.body.configFingerprint).toBe(refreshed.body.fingerprint);
    expect(retried.body.forecast.yieldDeltaPct).toBeLessThan(0);
    expect(retried.body.impactSummary).toBeDefined();
  });
});
