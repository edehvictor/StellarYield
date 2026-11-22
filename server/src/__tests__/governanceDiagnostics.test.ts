/**
 * Regression tests for governance failure diagnostics (#1901).
 *
 * Covers normal operation, validation failure, an unexpected stage failure,
 * privacy of the returned diagnostics, and safe retry behaviour: a failed
 * request must not change any stored state, and a corrected retry must succeed.
 */
import request from "supertest";
import express from "express";
import { createHash } from "crypto";

// Force one deterministic internal failure without touching real services.
jest.mock("../services/governanceForecastService", () => {
  const actual = jest.requireActual("../services/governanceForecastService") as {
    forecastGovernanceProposal: (input: {
      parameters?: Record<string, number>;
    }) => unknown;
  };
  return {
    ...actual,
    forecastGovernanceProposal: (input: { parameters?: Record<string, number> }) => {
      if (input.parameters?.simulateStageFailure === 1) {
        throw new Error(
          "upstream RPC https://internal.example failed for GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
      }
      return actual.forecastGovernanceProposal(input);
    },
  };
});

import governanceRouter from "../routes/governance";
import {
  areGovernanceDiagnosticsPrivacySafe,
  type GovernanceDiagnostic,
} from "../../../shared/types/governanceDiagnostic";

const app = express();
app.use(express.json());
app.use("/api/governance", governanceRouter);

const VALID_FORECAST = {
  proposalType: "fee_change",
  parameters: { feeRatePct: 3 },
  baseline: {
    yieldPct: 8,
    exposurePct: 40,
    feeRatePct: 2,
    tvlUsd: 10_000_000,
  },
};

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validRunbook() {
  const content = "# Emergency Runbook";
  return {
    kind: "runbook",
    filename: "emergency-runbook.md",
    contentType: "text/markdown",
    sizeBytes: content.length,
    sha256: sha256(content),
    manifestReference: "deployment-manifest.json@a1b2c3d",
  };
}

function diagnosticsOf(body: unknown): GovernanceDiagnostic[] {
  return (body as { diagnostics?: GovernanceDiagnostic[] }).diagnostics ?? [];
}

describe("governance diagnostics (#1901)", () => {
  describe("normal operation", () => {
    it("returns the forecast without failure diagnostics", async () => {
      const res = await request(app)
        .post("/api/governance/forecast")
        .send(VALID_FORECAST);

      expect(res.status).toBe(200);
      expect(res.body.forecast).toBeDefined();
      expect(res.body.diagnostics).toBeUndefined();
    });

    it("validates a well-formed attachment and returns no diagnostics", async () => {
      const res = await request(app)
        .post("/api/governance/proposals/attachments/validate")
        .send({ attachments: [validRunbook()] });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.diagnostics).toBeUndefined();
    });

    it("computes quorum progress without diagnostics", async () => {
      const res = await request(app)
        .post("/api/governance/quorum-progress")
        .send({
          signers: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
          signatures: [],
          threshold: 1,
        });

      expect(res.status).toBe(200);
      expect(res.body.required).toBe(1);
      expect(res.body.diagnostics).toBeUndefined();
    });
  });

  describe("validation failure", () => {
    it("names the failed stage and remediation path for an invalid forecast", async () => {
      const res = await request(app)
        .post("/api/governance/forecast")
        .send({ proposalType: "unknown_type" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("VALIDATION_FAILED");
      expect(res.body.stage).toBe("request-validation");
      expect(res.body.fields).toEqual([
        "proposalType",
        "parameters",
        "baseline",
      ]);

      const diagnostics = diagnosticsOf(res.body);
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "VALIDATION_FAILED",
        "STATE_PRESERVED",
      ]);
      expect(diagnostics[1].stage).toBe("state-persistence");
      expect(diagnostics[1].affectedStages).toEqual(["request-validation"]);
      expect(areGovernanceDiagnosticsPrivacySafe(diagnostics)).toBe(true);
    });

    it("never echoes submitted values, wallets, URLs, or XDR in the response", async () => {
      const wallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      const xdr = "AAAAAgAAAAB-submitted-secret-xdr";
      const res = await request(app)
        .post("/api/governance/proposals/attachments/validate")
        .send({
          attachments: [
            {
              ...validRunbook(),
              filename: "https://rpc.internal.example/steal.json",
              manifestReference: wallet,
              xdr,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(diagnosticsOf(res.body).length).toBeGreaterThan(0);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(wallet);
      expect(serialized).not.toContain("https://rpc.internal.example");
      expect(serialized).not.toContain(xdr);
    });

    it("rejects a non-string XDR with a field error instead of a 500", async () => {
      const res = await request(app)
        .post("/api/governance/proposals/attachments/validate")
        .send({
          attachments: [
            {
              kind: "transaction_payload",
              filename: "payload.xdr",
              contentType: "application/xdr",
              sizeBytes: 12,
              sha256: sha256("xdr"),
              manifestReference: "deployment-manifest.json@a1b2c3d",
              xdr: { not: "a string" },
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(
        res.body.errors.some(
          (error: { field: string }) => error.field === "xdr",
        ),
      ).toBe(true);
      expect(res.body.error).toBe("VALIDATION_FAILED");
    });
  });

  describe("stage failure", () => {
    it("reports a privacy-safe stage failure without raw error text", async () => {
      const res = await request(app)
        .post("/api/governance/forecast")
        .send({
          ...VALID_FORECAST,
          parameters: { feeRatePct: 3, simulateStageFailure: 1 },
        });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("STAGE_UNAVAILABLE");
      expect(res.body.stage).toBe("forecast");
      expect(res.body.retryable).toBe(true);

      const diagnostics = diagnosticsOf(res.body);
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "STAGE_UNAVAILABLE",
        "STATE_PRESERVED",
      ]);
      expect(areGovernanceDiagnosticsPrivacySafe(diagnostics)).toBe(true);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("internal.example");
      expect(serialized).not.toContain("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
      expect(serialized).not.toMatch(/upstream RPC|at Object|stack/i);
    });

    it("treats malformed attachment metadata as validation, not a 500", async () => {
      const res = await request(app)
        .post("/api/governance/proposals/attachments/validate")
        .send({
          attachments: [{ ...validRunbook(), manifestReference: {} }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("VALIDATION_FAILED");
      expect(res.body.stage).toBe("attachments");
      expect(
        res.body.errors.some(
          (error: { field: string }) => error.field === "manifestReference",
        ),
      ).toBe(true);
    });
  });

  describe("safe retry", () => {
    it("leaves no partially-applied state and accepts the corrected request", async () => {
      const failed = await request(app)
        .post("/api/governance/proposals/attachments/validate")
        .send({ attachments: [{ ...validRunbook(), manifestReference: {} }] });

      expect(failed.status).toBe(400);

      const retried = await request(app)
        .post("/api/governance/proposals/attachments/validate")
        .send({ attachments: [validRunbook()] });

      expect(retried.status).toBe(200);
      expect(retried.body.valid).toBe(true);
      expect(retried.body.diagnostics).toBeUndefined();
    });

    it("recovers the forecast stage on retry after a transient failure", async () => {
      const failed = await request(app)
        .post("/api/governance/forecast")
        .send({
          ...VALID_FORECAST,
          parameters: { feeRatePct: 3, simulateStageFailure: 1 },
        });

      expect(failed.status).toBe(500);
      expect(failed.body.retryable).toBe(true);

      const retried = await request(app)
        .post("/api/governance/forecast")
        .send(VALID_FORECAST);

      expect(retried.status).toBe(200);
      expect(retried.body.forecast).toBeDefined();
    });

    it("allows a corrected forecast retry after a validation failure", async () => {
      const failed = await request(app)
        .post("/api/governance/forecast")
        .send({ proposalType: "fee_change" });

      expect(failed.status).toBe(400);

      const retried = await request(app)
        .post("/api/governance/forecast")
        .send(VALID_FORECAST);

      expect(retried.status).toBe(200);
      expect(retried.body.forecast).toBeDefined();
    });
  });
});
