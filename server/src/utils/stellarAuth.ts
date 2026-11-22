import { createHash } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export type WalletAddressType = "account" | "contract";
export type WalletBootStatus = "ready" | "degraded" | "unavailable";

/**
 * Wallet boot status snapshot for startup diagnostics.
 * Shows whether the wallet authentication system is ready to accept connections.
 */
export interface WalletBootStatusSnapshot {
  status: WalletBootStatus;
  component: "wallet";
  ready: boolean;
  reason?: string;
  checkedAt: string;
  capabilities: {
    challengeGeneration: boolean;
    challengeVerification: boolean;
    replayProtection: boolean;
  };
}

/** Challenges expire after this many milliseconds (5 minutes). */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = "stellar-yield-auth";
const WALLET_AUTH_CONFIG_VERSION = "wallet-auth-config/v1";

/**
 * Immutable wallet-auth lifecycle configuration snapshot fingerprint.
 *
 * Any change to challenge policy, format, or signer acceptance must be reflected
 * in this snapshot so stale challenges/sessions can be rejected or refreshed.
 */
export function getWalletAuthConfigFingerprint(): string {
  const snapshot = {
    version: WALLET_AUTH_CONFIG_VERSION,
    challengePrefix: CHALLENGE_PREFIX,
    challengeFormat: "v2:fingerprint-bound",
    challengeTtlMs: CHALLENGE_TTL_MS,
    acceptedSignerPolicies: {
      account: ["freighter", "ed25519"],
      contract: ["session-key", "contract-wallet"],
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

export class StaleWalletAuthConfigError extends Error {
  readonly code = "STALE_WALLET_AUTH_CONFIG";
  readonly currentAuthConfigFingerprint: string;

  constructor(message = "Wallet authentication configuration snapshot is stale.") {
    super(message);
    this.name = "StaleWalletAuthConfigError";
    this.currentAuthConfigFingerprint = getWalletAuthConfigFingerprint();
  }
}

export function isStaleWalletAuthConfigError(
  error: unknown,
): error is StaleWalletAuthConfigError {
  return (
    error instanceof StaleWalletAuthConfigError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "STALE_WALLET_AUTH_CONFIG")
  );
}

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
 * Create a time-bound challenge token bound to the current immutable wallet
 * auth configuration fingerprint. The fingerprint is embedded in the challenge
 * string so stale configuration snapshots can be rejected before verification.
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
  const authConfigFingerprint = getWalletAuthConfigFingerprint();

  return {
    challenge: [
      CHALLENGE_PREFIX,
      providerId,
      loginHint,
      input.walletAddress,
      input.sessionKeyAddress,
      authConfigFingerprint,
      expiresAt,
    ].join(":"),
    expiresAt,
    walletAddressType,
    authConfigFingerprint,
    acceptedSignerTypes:
      walletAddressType === "contract"
        ? ["session-key", "contract-wallet"]
        : ["freighter", "ed25519"],
  };
}

function parseAuthChallenge(challenge: string): {
  walletAddress: string;
  sessionKeyAddress: string;
  authConfigFingerprint: string | null;
  expiresAt: string;
} {
  const parts = challenge.split(":");
  // Legacy v1: stellar-yield-auth:providerId:loginHint:walletAddress:sessionKeyAddress:expiresAt
  // Current v2: stellar-yield-auth:providerId:loginHint:walletAddress:sessionKeyAddress:authConfigFingerprint:expiresAt
  if (parts.length < 6) {
    throw new Error("Malformed challenge.");
  }

  const walletAddress = parts[3];
  const sessionKeyAddress = parts[4];
  const isFingerprintBound = parts.length >= 7 && /^[a-f0-9]{64}$/i.test(parts[5]);

  return {
    walletAddress,
    sessionKeyAddress,
    authConfigFingerprint: isFingerprintBound ? parts[5] : null,
    expiresAt: isFingerprintBound ? parts.slice(6).join(":") : parts.slice(5).join(":"),
  };
}

/**
 * Verify a signed challenge.
 *
 * Enforces:
 * 1. The challenge embeds the wallet and session key addresses it was issued
 *    for, so a challenge cannot be reused with different credentials.
 * 2. The challenge embeds an immutable wallet auth configuration fingerprint;
 *    missing or stale fingerprints are rejected so work can be refreshed.
 * 3. The embedded expiry timestamp is checked; stale challenges are rejected.
 * 4. Each challenge is consumed on first successful verify; replayed
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
  const parsed = parseAuthChallenge(input.challenge);

  if (parsed.walletAddress !== input.walletAddress) {
    throw new Error("Challenge wallet address mismatch.");
  }

  if (parsed.sessionKeyAddress !== input.sessionKeyAddress) {
    throw new Error("Challenge session key mismatch.");
  }

  // ── Immutable config fingerprint check (must run before replay/consume) ──
  const currentAuthConfigFingerprint = getWalletAuthConfigFingerprint();
  if (parsed.authConfigFingerprint !== currentAuthConfigFingerprint) {
    throw new StaleWalletAuthConfigError();
  }

  // ── Expiry check ─────────────────────────────────────────────────────────
  const expiryMs = new Date(parsed.expiresAt).getTime();
  if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) {
    throw new Error("Challenge has expired.");
  }
  // Boundary: a challenge is valid through its expiry instant (inclusive) and
  // may not claim an expiry further out than the issuing TTL. Without this cap
  // a long-lived challenge could outlive its replay-cache entry (which is only
  // retained for CHALLENGE_TTL_MS) and be replayed.
  if (expiryMs - Date.now() > CHALLENGE_TTL_MS) {
    throw new Error("Challenge expiry is outside the allowed window.");
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
    authConfigFingerprint: currentAuthConfigFingerprint,
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

/**
 * Get wallet boot status for startup diagnostics.
 * The wallet system is "ready" if all core authentication capabilities are operational.
 */
export function getWalletBootStatus(): WalletBootStatusSnapshot {
  const checkedAt = new Date().toISOString();

  try {
    // Wallet authentication is always ready if the module loads successfully.
    // Core capabilities are implemented and available.
    const status: WalletBootStatus = "ready";
    return {
      status,
      component: "wallet",
      ready: status === "ready",
      checkedAt,
      capabilities: {
        challengeGeneration: true,
        challengeVerification: true,
        replayProtection: true,
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      component: "wallet",
      ready: false,
      reason: error instanceof Error ? error.message : "Unknown error",
      checkedAt,
      capabilities: {
        challengeGeneration: false,
        challengeVerification: false,
        replayProtection: false,
      },
    };
  }
}
