import request from "supertest";
import express from "express";
import { createHash } from "crypto";
import governanceRouter from "../routes/governance";

const app = express();
app.use(express.json());
app.use("/api/governance", governanceRouter);

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function manifestAttachment(overrides: Record<string, unknown> = {}) {
  const content = JSON.stringify({ version: "1.0.0" });
  return {
    kind: "manifest",
    filename: "deployment-manifest.json",
    contentType: "application/json",
    sizeBytes: content.length,
    sha256: sha256(content),
    manifestReference: "deployment-manifest.json@a1b2c3d",
    ...overrides,
  };
}

function runbookAttachment(overrides: Record<string, unknown> = {}) {
  const content = "# Emergency Runbook\n\nPause, verify, notify, resume.";
  return {
    kind: "runbook",
    filename: "emergency-runbook.md",
    contentType: "text/markdown",
    sizeBytes: content.length,
    sha256: sha256(content),
    manifestReference: "deployment-manifest.json@a1b2c3d",
    ...overrides,
  };
}

function transactionPayloadAttachment(overrides: Record<string, unknown> = {}) {
  const xdr = "AAAAAgAAAABmock-xdr-envelope-content";
  return {
    kind: "transaction_payload",
    filename: "set-keeper-fee.xdr",
    contentType: "application/xdr",
    sizeBytes: xdr.length,
    sha256: sha256(xdr),
    manifestReference: "deployment-manifest.json@a1b2c3d",
    xdr,
    ...overrides,
  };
}

describe("POST /api/governance/proposals/attachments/validate", () => {
  it("accepts a valid set of manifest, runbook, and transaction_payload attachments", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({
        attachments: [
          manifestAttachment(),
          runbookAttachment(),
          transactionPayloadAttachment(),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toHaveLength(0);
    expect(res.body.attachments).toHaveLength(3);
  });

  it("rejects an empty attachments array", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments: [] });

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
  });

  it("rejects a request with no attachments field", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
  });

  it("rejects an unsupported attachment kind", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments: [manifestAttachment({ kind: "screenshot" })] });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("kind");
  });

  it("rejects an unsupported content type for the given kind", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments: [manifestAttachment({ contentType: "image/png" })] });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { field: string }) => e.field === "contentType")).toBe(true);
  });

  it("rejects a malformed sha256 digest", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments: [manifestAttachment({ sha256: "not-a-hash" })] });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { field: string }) => e.field === "sha256")).toBe(true);
  });

  it("rejects an attachment exceeding the per-kind size cap", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments: [manifestAttachment({ sizeBytes: 10 * 1024 * 1024 })] });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { field: string }) => e.field === "sizeBytes")).toBe(true);
  });

  it("rejects an attachment missing its manifest reference", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments: [runbookAttachment({ manifestReference: "" })] });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { field: string }) => e.field === "manifestReference")).toBe(true);
  });

  it("rejects a transaction_payload attachment missing its xdr", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments: [transactionPayloadAttachment({ xdr: undefined })] });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { field: string }) => e.field === "xdr")).toBe(true);
  });

  it("rejects a transaction_payload attachment whose sha256 does not match its xdr", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({
        attachments: [transactionPayloadAttachment({ sha256: sha256("different content") })],
      });

    expect(res.status).toBe(400);
    expect(
      res.body.errors.some(
        (e: { field: string; message: string }) =>
          e.field === "sha256" && e.message.includes("does not match"),
      ),
    ).toBe(true);
  });

  it("rejects more than the maximum number of attachments", async () => {
    const attachments = Array.from({ length: 21 }, () => manifestAttachment());
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({ attachments });

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
  });

  it("reports errors for every invalid attachment, keyed by index", async () => {
    const res = await request(app)
      .post("/api/governance/proposals/attachments/validate")
      .send({
        attachments: [
          manifestAttachment(),
          runbookAttachment({ manifestReference: "" }),
          transactionPayloadAttachment({ xdr: undefined }),
        ],
      });

    expect(res.status).toBe(400);
    const indexes = res.body.errors.map((e: { index: number }) => e.index);
    expect(indexes).toContain(1);
    expect(indexes).toContain(2);
    expect(indexes).not.toContain(0);
  });
});
