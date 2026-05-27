import { Keypair, StrKey } from "@stellar/stellar-sdk";
import request from "supertest";
import { createApp } from "../app";
import {
  createAuthChallenge,
  getWalletAddressType,
  verifyAuthChallenge,
} from "../utils/stellarAuth";

describe("stellarAuth utilities", () => {
  it("classifies account and contract addresses", () => {
    const accountAddress = Keypair.random().publicKey();
    const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 7));

    expect(getWalletAddressType(accountAddress)).toBe("account");
    expect(getWalletAddressType(contractAddress)).toBe("contract");
    expect(getWalletAddressType("bad-address")).toBeNull();
  });

  it("verifies a session key challenge for a smart wallet", () => {
    const sessionKey = Keypair.random();
    const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 9));
    const authChallenge = createAuthChallenge({
      walletAddress: contractAddress,
      sessionKeyAddress: sessionKey.publicKey(),
      providerId: "google",
      loginHint: "builder@example.com",
    });

    const signature = sessionKey
      .sign(Buffer.from(authChallenge.challenge, "utf8"))
      .toString("base64");

    expect(
      verifyAuthChallenge({
        walletAddress: contractAddress,
        sessionKeyAddress: sessionKey.publicKey(),
        challenge: authChallenge.challenge,
        signature,
      }),
    ).toMatchObject({
      verified: true,
      walletAddressType: "contract",
    });
  });
});

describe("smart wallet auth routes", () => {
  const app = createApp();

  it("issues a challenge for smart wallet sessions", async () => {
    const sessionKey = Keypair.random();
    const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 3));

    const response = await request(app).post("/api/auth/challenge").send({
      walletAddress: contractAddress,
      sessionKeyAddress: sessionKey.publicKey(),
      providerId: "github",
      loginHint: "@stellarbuilder",
    });

    expect(response.status).toBe(200);
    expect(response.body.walletAddressType).toBe("contract");
    expect(response.body.challenge).toContain(contractAddress);
  });

  it("rejects invalid wallet addresses", async () => {
    const sessionKey = Keypair.random();

    const response = await request(app).post("/api/auth/challenge").send({
      walletAddress: "bad-address",
      sessionKeyAddress: sessionKey.publicKey(),
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Invalid wallet address.");
  });

  it("accepts signatures from session keys bound to contract wallets", async () => {
    const sessionKey = Keypair.random();
    const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 11));

    const challengeResponse = await request(app).post("/api/auth/challenge").send({
      walletAddress: contractAddress,
      sessionKeyAddress: sessionKey.publicKey(),
      providerId: "email",
      loginHint: "user@example.com",
    });

    const signature = sessionKey
      .sign(Buffer.from(challengeResponse.body.challenge, "utf8"))
      .toString("base64");

    const verifyResponse = await request(app).post("/api/auth/verify").send({
      walletAddress: contractAddress,
      sessionKeyAddress: sessionKey.publicKey(),
      challenge: challengeResponse.body.challenge,
      signature,
    });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.verified).toBe(true);
    expect(verifyResponse.body.walletAddressType).toBe("contract");
  });
});
