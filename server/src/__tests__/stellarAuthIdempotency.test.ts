/**
 * #1880 — Harden wallet lifecycle against duplicate submissions.
 *
 * A verify request may carry an operation identity (`operationId` body field
 * or `Idempotency-Key` header). Safe retries of a completed verification are
 * answered from the recorded outcome and never apply the effect twice; failed
 * verifications leave no state behind and remain retryable.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import request from "supertest";
import { createApp } from "../app";
import {
  createAuthChallenge,
  normalizeWalletOperationId,
  verifyAuthChallenge,
  _resetReplayCacheForTesting,
} from "../utils/stellarAuth";

function makeContractAddress(seed = 5): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

function signChallenge(sessionKey: Keypair, challenge: string): string {
  return sessionKey.sign(Buffer.from(challenge, "utf8")).toString("base64");
}

function issue(seed = 5) {
  const sessionKey = Keypair.random();
  const walletAddress = makeContractAddress(seed);
  const { challenge } = createAuthChallenge({
    walletAddress,
    sessionKeyAddress: sessionKey.publicKey(),
  });
  return {
    sessionKey,
    walletAddress,
    challenge,
    body: {
      walletAddress,
      sessionKeyAddress: sessionKey.publicKey(),
      challenge,
      signature: signChallenge(sessionKey, challenge),
    },
  };
}

beforeEach(() => _resetReplayCacheForTesting());
afterEach(() => jest.useRealTimers());

describe("normalizeWalletOperationId", () => {
  it("treats missing values as no operation identity", () => {
    expect(normalizeWalletOperationId(undefined)).toBeUndefined();
    expect(normalizeWalletOperationId(null)).toBeUndefined();
    expect(normalizeWalletOperationId("")).toBeUndefined();
  });

  it("accepts and trims well-formed ids", () => {
    expect(normalizeWalletOperationId("  wallet-verify-abc123  ")).toBe(
      "wallet-verify-abc123",
    );
  });

  it.each([["short"], ["has space inside"], ["x".repeat(129)], [42], [{}]])(
    "rejects malformed id %p",
    (value) => {
      expect(() => normalizeWalletOperationId(value)).toThrow(/operationId/);
    },
  );
});

describe("verifyAuthChallenge — operation identity (#1880)", () => {
  it("normal operation: verifies once and echoes the operation identity", () => {
    const { body } = issue();
    const result = verifyAuthChallenge({ ...body, operationId: "op-normal-0001" });

    expect(result.verified).toBe(true);
    expect(result.operationId).toBe("op-normal-0001");
    expect(result.replayed).toBe(false);
  });

  it("safe retry: same id and payload returns the recorded outcome without re-applying", () => {
    const { body } = issue();
    const first = verifyAuthChallenge({ ...body, operationId: "op-retry-0001" });
    const retry = verifyAuthChallenge({ ...body, operationId: "op-retry-0001" });

    expect(retry).toEqual({ ...first, replayed: true });

    // The challenge itself was consumed exactly once: a submission without the
    // operation identity is still rejected as a replay.
    expect(() => verifyAuthChallenge(body)).toThrow("Challenge has already been used.");
  });

  it("safe retry still succeeds after the challenge expiry passes within the record window", () => {
    jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z") });
    const { body } = issue();
    verifyAuthChallenge({ ...body, operationId: "op-late-retry-1" });

    jest.setSystemTime(new Date("2026-01-01T00:04:59.000Z"));
    expect(
      verifyAuthChallenge({ ...body, operationId: "op-late-retry-1" }).replayed,
    ).toBe(true);
  });

  it("forgets completed operations after the retry window", () => {
    jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z") });
    const { body } = issue();
    verifyAuthChallenge({ ...body, operationId: "op-expiring-1" });

    jest.setSystemTime(new Date("2026-01-01T00:05:01.000Z"));
    expect(() =>
      verifyAuthChallenge({ ...body, operationId: "op-expiring-1" }),
    ).toThrow("Challenge has expired.");
  });

  it("a different operation id cannot replay a consumed challenge", () => {
    const { body } = issue();
    verifyAuthChallenge({ ...body, operationId: "op-first-0001" });

    expect(() =>
      verifyAuthChallenge({ ...body, operationId: "op-second-001" }),
    ).toThrow("Challenge has already been used.");
  });

  it("rejects reuse of an operation id for a different payload", () => {
    const a = issue(6);
    const b = issue(7);
    verifyAuthChallenge({ ...a.body, operationId: "op-conflict-01" });

    expect(() =>
      verifyAuthChallenge({ ...b.body, operationId: "op-conflict-01" }),
    ).toThrow(expect.objectContaining({ code: "WALLET_OPERATION_CONFLICT" }));

    // The conflicting request applied nothing: its challenge is still usable.
    expect(verifyAuthChallenge(b.body).verified).toBe(true);
  });

  it("failure: a bad signature is not recorded and the operation can be retried", () => {
    const { body, sessionKey, challenge } = issue();
    const bad = verifyAuthChallenge({
      ...body,
      signature: Buffer.alloc(64, 1).toString("base64"),
      operationId: "op-fail-retry1",
    });
    expect(bad.verified).toBe(false);

    const retried = verifyAuthChallenge({
      ...body,
      signature: signChallenge(sessionKey, challenge),
      operationId: "op-fail-retry1",
    });
    expect(retried.verified).toBe(true);
    expect(retried.replayed).toBe(false);
  });

  it("failure: validation errors leave no state behind", () => {
    const { body } = issue();
    expect(() =>
      verifyAuthChallenge({
        ...body,
        walletAddress: makeContractAddress(9),
        operationId: "op-invalid-001",
      }),
    ).toThrow("Challenge wallet address mismatch.");

    const ok = verifyAuthChallenge({ ...body, operationId: "op-invalid-001" });
    expect(ok.verified).toBe(true);
    expect(ok.replayed).toBe(false);
  });

  it("rejects a malformed operation id before any side effect", () => {
    const { body } = issue();
    expect(() => verifyAuthChallenge({ ...body, operationId: "bad id" })).toThrow(
      expect.objectContaining({ code: "INVALID_WALLET_OPERATION_ID" }),
    );
    expect(verifyAuthChallenge(body).verified).toBe(true);
  });

  it("without an operation identity the existing replay rejection is unchanged", () => {
    const { body } = issue();
    const result = verifyAuthChallenge(body);
    expect(result.verified).toBe(true);
    expect(result.operationId).toBeUndefined();
    expect(result.replayed).toBeUndefined();
    expect(() => verifyAuthChallenge(body)).toThrow("Challenge has already been used.");
  });
});

describe("POST /api/auth/verify — operation identity over HTTP (#1880)", () => {
  const app = createApp();

  it("returns the recorded outcome for a retried request with the same Idempotency-Key", async () => {
    const { body } = issue();

    const first = await request(app)
      .post("/api/auth/verify")
      .set("Idempotency-Key", "op-http-retry-1")
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      verified: true,
      operationId: "op-http-retry-1",
      replayed: false,
    });

    const retry = await request(app)
      .post("/api/auth/verify")
      .set("Idempotency-Key", "op-http-retry-1")
      .send(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      verified: true,
      operationId: "op-http-retry-1",
      replayed: true,
    });
  });

  it("accepts the operation identity in the body", async () => {
    const { body } = issue();
    const res = await request(app)
      .post("/api/auth/verify")
      .send({ ...body, operationId: "op-http-body-1" });
    expect(res.status).toBe(200);
    expect(res.body.operationId).toBe("op-http-body-1");
  });

  it("returns 409 WALLET_OPERATION_CONFLICT when an id is reused for another payload", async () => {
    const a = issue(6);
    const b = issue(7);
    await request(app)
      .post("/api/auth/verify")
      .set("Idempotency-Key", "op-http-conflict")
      .send(a.body)
      .expect(200);

    const res = await request(app)
      .post("/api/auth/verify")
      .set("Idempotency-Key", "op-http-conflict")
      .send(b.body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("WALLET_OPERATION_CONFLICT");
  });

  it("returns 400 INVALID_WALLET_OPERATION_ID for a malformed id", async () => {
    const { body } = issue();
    const res = await request(app)
      .post("/api/auth/verify")
      .set("Idempotency-Key", "bad")
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_WALLET_OPERATION_ID");
  });

  it("returns 400 when the header and body ids disagree, without consuming the challenge", async () => {
    const { body } = issue();
    const res = await request(app)
      .post("/api/auth/verify")
      .set("Idempotency-Key", "op-http-header1")
      .send({ ...body, operationId: "op-http-body-02" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_WALLET_OPERATION_ID");

    await request(app).post("/api/auth/verify").send(body).expect(200);
  });
});
