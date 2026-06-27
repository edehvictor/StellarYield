/**
 * #730 — Wallet session challenge verification: replay and expiry hardening.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import request from "supertest";
import { createApp } from "../app";
import {
  createAuthChallenge,
  getWalletAddressType,
  verifyAuthChallenge,
  _resetReplayCacheForTesting,
} from "../utils/stellarAuth";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeContractAddress(seed = 3): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

function signChallenge(sessionKey: Keypair, challenge: string): string {
  return sessionKey.sign(Buffer.from(challenge, "utf8")).toString("base64");
}

// ── Unit tests ───────────────────────────────────────────────────────────────

describe("getWalletAddressType", () => {
  it("classifies account addresses", () => {
    expect(getWalletAddressType(Keypair.random().publicKey())).toBe("account");
  });

  it("classifies contract addresses", () => {
    expect(getWalletAddressType(makeContractAddress())).toBe("contract");
  });

  it("returns null for invalid input", () => {
    expect(getWalletAddressType("bad-address")).toBeNull();
  });
});

describe("createAuthChallenge", () => {
  it("embeds walletAddress, sessionKeyAddress, and expiresAt in the challenge string", () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(1);
    const { challenge, expiresAt } = createAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
    });

    expect(challenge).toContain(wallet);
    expect(challenge).toContain(sessionKey.publicKey());
    expect(challenge).toContain(expiresAt);
  });

  it("expiresAt is in the future", () => {
    const sessionKey = Keypair.random();
    const { expiresAt } = createAuthChallenge({
      walletAddress: makeContractAddress(2),
      sessionKeyAddress: sessionKey.publicKey(),
    });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("throws on invalid wallet address", () => {
    expect(() =>
      createAuthChallenge({
        walletAddress: "bad",
        sessionKeyAddress: Keypair.random().publicKey(),
      }),
    ).toThrow("Invalid wallet address.");
  });

  it("throws on invalid session key address", () => {
    expect(() =>
      createAuthChallenge({
        walletAddress: makeContractAddress(4),
        sessionKeyAddress: "not-a-key",
      }),
    ).toThrow("Invalid session key address.");
  });
});

describe("verifyAuthChallenge — positive path", () => {
  beforeEach(() => _resetReplayCacheForTesting());

  it("verifies a correctly signed challenge", () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(5);
    const { challenge } = createAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
    });
    const signature = signChallenge(sessionKey, challenge);

    const result = verifyAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
      challenge,
      signature,
    });

    expect(result.verified).toBe(true);
    expect(result.walletAddressType).toBe("contract");
  });
});

describe("verifyAuthChallenge — replay protection", () => {
  beforeEach(() => _resetReplayCacheForTesting());

  it("rejects a challenge that has already been verified", () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(6);
    const { challenge } = createAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
    });
    const signature = signChallenge(sessionKey, challenge);
    const args = {
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
      challenge,
      signature,
    };

    // First call succeeds
    expect(verifyAuthChallenge(args).verified).toBe(true);
    // Second call is a replay
    expect(() => verifyAuthChallenge(args)).toThrow("Challenge has already been used.");
  });

  it("rejects a challenge with bad signature without consuming it", () => {
    const sessionKey = Keypair.random();
    const otherKey = Keypair.random();
    const wallet = makeContractAddress(7);
    const { challenge } = createAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
    });
    const badSignature = signChallenge(otherKey, challenge);

    const result = verifyAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
      challenge,
      signature: badSignature,
    });

    // A bad signature does NOT consume the challenge
    expect(result.verified).toBe(false);

    // The legitimate owner can still use it
    const goodSignature = signChallenge(sessionKey, challenge);
    expect(
      verifyAuthChallenge({
        walletAddress: wallet,
        sessionKeyAddress: sessionKey.publicKey(),
        challenge,
        signature: goodSignature,
      }).verified,
    ).toBe(true);
  });
});

describe("verifyAuthChallenge — expiry", () => {
  beforeEach(() => _resetReplayCacheForTesting());

  it("rejects a challenge with an expired timestamp", () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(8);

    // Build a challenge whose expiry is in the past
    const expiredExpiresAt = new Date(Date.now() - 1000).toISOString();
    const staleParts = [
      "stellar-yield-auth",
      "freighter",
      "anonymous",
      wallet,
      sessionKey.publicKey(),
      expiredExpiresAt,
    ];
    const staleChallenge = staleParts.join(":");
    const signature = signChallenge(sessionKey, staleChallenge);

    expect(() =>
      verifyAuthChallenge({
        walletAddress: wallet,
        sessionKeyAddress: sessionKey.publicKey(),
        challenge: staleChallenge,
        signature,
      }),
    ).toThrow("Challenge has expired.");
  });
});

describe("verifyAuthChallenge — binding checks", () => {
  beforeEach(() => _resetReplayCacheForTesting());

  it("rejects when walletAddress does not match the one in the challenge", () => {
    const sessionKey = Keypair.random();
    const originalWallet = makeContractAddress(9);
    const differentWallet = makeContractAddress(10);
    const { challenge } = createAuthChallenge({
      walletAddress: originalWallet,
      sessionKeyAddress: sessionKey.publicKey(),
    });
    const signature = signChallenge(sessionKey, challenge);

    expect(() =>
      verifyAuthChallenge({
        walletAddress: differentWallet,
        sessionKeyAddress: sessionKey.publicKey(),
        challenge,
        signature,
      }),
    ).toThrow("Challenge wallet address mismatch.");
  });

  it("rejects when sessionKeyAddress does not match the one in the challenge", () => {
    const sessionKey = Keypair.random();
    const otherKey = Keypair.random();
    const wallet = makeContractAddress(11);
    const { challenge } = createAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
    });
    const signature = signChallenge(sessionKey, challenge);

    expect(() =>
      verifyAuthChallenge({
        walletAddress: wallet,
        sessionKeyAddress: otherKey.publicKey(),
        challenge,
        signature,
      }),
    ).toThrow("Challenge session key mismatch.");
  });

  it("rejects a malformed challenge string", () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(12);

    expect(() =>
      verifyAuthChallenge({
        walletAddress: wallet,
        sessionKeyAddress: sessionKey.publicKey(),
        challenge: "too:short",
        signature: "sig",
      }),
    ).toThrow("Malformed challenge.");
  });
});

describe("verifyAuthChallenge — missing fields", () => {
  beforeEach(() => _resetReplayCacheForTesting());

  it("throws on empty challenge", () => {
    expect(() =>
      verifyAuthChallenge({
        walletAddress: makeContractAddress(13),
        sessionKeyAddress: Keypair.random().publicKey(),
        challenge: "",
        signature: "sig",
      }),
    ).toThrow("Challenge is required.");
  });

  it("throws on empty signature", () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(14);
    const { challenge } = createAuthChallenge({
      walletAddress: wallet,
      sessionKeyAddress: sessionKey.publicKey(),
    });
    expect(() =>
      verifyAuthChallenge({
        walletAddress: wallet,
        sessionKeyAddress: sessionKey.publicKey(),
        challenge,
        signature: "",
      }),
    ).toThrow("Signature is required.");
  });
});

// ── HTTP route integration tests ─────────────────────────────────────────────

describe("POST /api/auth/challenge + /api/auth/verify — HTTP integration", () => {
  const app = createApp();
  beforeEach(() => _resetReplayCacheForTesting());

  it("issues and verifies a challenge end-to-end", async () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(20);

    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: wallet, sessionKeyAddress: sessionKey.publicKey() });
    expect(challengeRes.status).toBe(200);
    const { challenge } = challengeRes.body as { challenge: string };

    const signature = signChallenge(sessionKey, challenge);
    const verifyRes = await request(app)
      .post("/api/auth/verify")
      .send({ walletAddress: wallet, sessionKeyAddress: sessionKey.publicKey(), challenge, signature });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.verified).toBe(true);
  });

  it("returns 400 for invalid wallet address", async () => {
    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: "bad", sessionKeyAddress: Keypair.random().publicKey() });
    expect(res.status).toBe(400);
  });

  it("returns 400 when replaying a used challenge via HTTP", async () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(21);

    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: wallet, sessionKeyAddress: sessionKey.publicKey() });
    const { challenge } = challengeRes.body as { challenge: string };
    const signature = signChallenge(sessionKey, challenge);
    const body = { walletAddress: wallet, sessionKeyAddress: sessionKey.publicKey(), challenge, signature };

    const first = await request(app).post("/api/auth/verify").send(body);
    expect(first.status).toBe(200);
    expect(first.body.verified).toBe(true);

    const second = await request(app).post("/api/auth/verify").send(body);
    expect(second.status).toBe(400);
  });

  it("returns 400 for an expired challenge via HTTP", async () => {
    const sessionKey = Keypair.random();
    const wallet = makeContractAddress(22);
    const expiredExpiresAt = new Date(Date.now() - 1000).toISOString();
    const staleChallenge = [
      "stellar-yield-auth", "freighter", "anonymous",
      wallet, sessionKey.publicKey(), expiredExpiresAt,
    ].join(":");
    const signature = signChallenge(sessionKey, staleChallenge);

    const res = await request(app)
      .post("/api/auth/verify")
      .send({ walletAddress: wallet, sessionKeyAddress: sessionKey.publicKey(), challenge: staleChallenge, signature });
    expect(res.status).toBe(400);
  });
});
