import { Keypair, StrKey } from "@stellar/stellar-sdk";

export type WalletAddressType = "account" | "contract";

/** Challenges expire after this many milliseconds (5 minutes). */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory replay cache: maps challenge string → expiry timestamp.
 * A challenge is "seen" once it has been verified. After the TTL window
 * the entry is no longer accepted anyway, so the map is pruned on each use.
 */
const usedChallenges = new Map<string, number>();

/** Remove entries that are past their TTL. */
function pruneExpiredChallenges(): void {
  const now = Date.now();
  for (const [challenge, expiry] of usedChallenges) {
    if (now > expiry) {
      usedChallenges.delete(challenge);
    }
  }
}

/** Mark a challenge as consumed. */
function consumeChallenge(challenge: string): void {
  usedChallenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
}

/** Returns true if the challenge has already been consumed. */
function isChallengeReplayed(challenge: string): boolean {
  pruneExpiredChallenges();
  return usedChallenges.has(challenge);
}

export function getWalletAddressType(
  address: string,
): WalletAddressType | null {
  if (StrKey.isValidEd25519PublicKey(address)) {
    return "account";
  }

  if (StrKey.isValidContract(address)) {
    return "contract";
  }

  return null;
}

/**
 * Create a time-bound challenge token.
 *
 * The challenge embeds an ISO expiry timestamp so that the verifier can
 * reject challenges that were issued too long ago, independently of whether
 * the server was restarted between issue and verify.
 */
export function createAuthChallenge(input: {
  walletAddress: string;
  sessionKeyAddress: string;
  providerId?: string;
  loginHint?: string;
}) {
  const walletAddressType = getWalletAddressType(input.walletAddress);

  if (!walletAddressType) {
    throw new Error("Invalid wallet address.");
  }

  if (!StrKey.isValidEd25519PublicKey(input.sessionKeyAddress)) {
    throw new Error("Invalid session key address.");
  }

  const providerId = input.providerId?.trim().toLowerCase() || "freighter";
  const loginHint = input.loginHint?.trim().toLowerCase() || "anonymous";
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

  return {
    challenge: [
      "stellar-yield-auth",
      providerId,
      loginHint,
      input.walletAddress,
      input.sessionKeyAddress,
      expiresAt,
    ].join(":"),
    expiresAt,
    walletAddressType,
    acceptedSignerTypes:
      walletAddressType === "contract"
        ? ["session-key", "contract-wallet"]
        : ["freighter", "ed25519"],
  };
}

/**
 * Verify a signed challenge.
 *
 * Enforces:
 * 1. The challenge embeds the wallet and session key addresses it was issued
 *    for, so a challenge cannot be reused with different credentials.
 * 2. The embedded expiry timestamp is checked; stale challenges are rejected.
 * 3. Each challenge is consumed on first successful verify; replayed
 *    submissions are rejected even within the TTL window.
 */
export function verifyAuthChallenge(input: {
  walletAddress: string;
  sessionKeyAddress: string;
  challenge: string;
  signature: string;
}) {
  const walletAddressType = getWalletAddressType(input.walletAddress);

  if (!walletAddressType) {
    throw new Error("Invalid wallet address.");
  }

  if (!StrKey.isValidEd25519PublicKey(input.sessionKeyAddress)) {
    throw new Error("Invalid session key address.");
  }

  if (!input.challenge?.trim()) {
    throw new Error("Challenge is required.");
  }

  if (!input.signature?.trim()) {
    throw new Error("Signature is required.");
  }

  // ── Binding check: the challenge must encode the presented wallet / key ──
  const parts = input.challenge.split(":");
  // Format: stellar-yield-auth:providerId:loginHint:walletAddress:sessionKeyAddress:expiresAt
  if (parts.length < 6) {
    throw new Error("Malformed challenge.");
  }
  const challengeWallet = parts[3];
  const challengeSessionKey = parts[4];
  const challengeExpiresAt = parts[5];

  if (challengeWallet !== input.walletAddress) {
    throw new Error("Challenge wallet address mismatch.");
  }

  if (challengeSessionKey !== input.sessionKeyAddress) {
    throw new Error("Challenge session key mismatch.");
  }

  // ── Expiry check ─────────────────────────────────────────────────────────
  const expiryMs = new Date(challengeExpiresAt).getTime();
  if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) {
    throw new Error("Challenge has expired.");
  }

  // ── Replay check ─────────────────────────────────────────────────────────
  if (isChallengeReplayed(input.challenge)) {
    throw new Error("Challenge has already been used.");
  }

  const verified = Keypair.fromPublicKey(input.sessionKeyAddress).verify(
    Buffer.from(input.challenge, "utf8"),
    Buffer.from(input.signature, "base64"),
  );

  if (verified) {
    consumeChallenge(input.challenge);
  }

  return {
    verified,
    walletAddressType,
    acceptedSignerTypes:
      walletAddressType === "contract"
        ? ["session-key", "contract-wallet"]
        : ["freighter", "ed25519"],
  };
}

/** Exported for tests only — reset replay cache between test cases. */
export function _resetReplayCacheForTesting(): void {
  usedChallenges.clear();
}
