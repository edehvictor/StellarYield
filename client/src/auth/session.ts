import { Buffer } from "buffer";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type {
  ConnectWalletOptions,
  ExtensionWalletProviderId,
  SessionPermission,
  SessionOrigin,
  VerificationStatus,
  WalletProviderId,
  WalletSession,
} from "./types";
import { getAdapter } from "./walletAdapters";
import { getApiBaseUrl } from "../lib/api";

const STORAGE_KEY = "stellar-yield.wallet-session";
const BROADCAST_CHANNEL_NAME = "stellar-yield-wallet-session";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;

const DEFAULT_PERMISSIONS: SessionPermission[] = ["read", "sign"];

let broadcastChannel: BroadcastChannel | null = null;

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!broadcastChannel) {
    broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  }
  return broadcastChannel;
}

export function broadcastSessionEvent(event: {
  type: "disconnect" | "account-change" | "session-update";
  payload?: WalletSession | null;
}) {
  const channel = getBroadcastChannel();
  channel?.postMessage(event);
}

export function onSessionEvent(
  handler: (event: { type: string; payload?: WalletSession | null }) => void,
): () => void {
  const channel = getBroadcastChannel();
  if (!channel) return () => {};

  const listener = (e: MessageEvent) => handler(e.data);
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}

function generateTabId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSessionOrigin(): SessionOrigin {
  return {
    tabId: generateTabId(),
    origin: typeof window !== "undefined" ? window.location.origin : "unknown",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
  };
}


interface ChallengeResponse {
  challenge: string;
  walletAddressType: "account" | "contract";
  acceptedSignerTypes: string[];
}

interface VerifyResponse {
  verified: boolean;
  walletAddressType: "account" | "contract";
  acceptedSignerTypes: string[];
}

const providerLabels: Record<WalletProviderId, string> = {
  freighter: "Freighter",
  xbull: "xBull",
  albedo: "Albedo",
  email: "Email Smart Wallet",
  google: "Google Smart Wallet",
  github: "GitHub Smart Wallet",
};

export function loadStoredSession(): WalletSession | null {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    const session = JSON.parse(stored) as WalletSession;
    // Reject non-object values (e.g. the literal string "null" or a number)
    if (!session || typeof session !== "object") {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch (error) {
    console.error("Failed to restore wallet session", error);
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export type SessionRecoveryStatus =
  | "recovered"        // Session is valid and provider is available
  | "degraded"         // Session loaded but provider unavailable or re-verification failed
  | "expired"          // Session exceeded TTL — cleared
  | "no_session";      // Nothing in storage

export interface SessionRecoveryResult {
  status: SessionRecoveryStatus;
  session: WalletSession | null;
}

/**
 * Attempt to recover a stored wallet session after a page reload.
 *
 * Recovery flow:
 *  1. Load the persisted session. Return `no_session` if nothing is stored.
 *  2. Reject expired sessions (TTL exceeded) — clears storage.
 *  3. For extension wallets, probe the provider's `isAvailable()` and update
 *     the `providerAvailable` flag on the session.
 *  4. For smart-wallet sessions that have a `sessionKeyAddress`, re-verify
 *     against the backend.  A network failure falls back to `degraded` rather
 *     than clearing the session so the user can still read data.
 *  5. Persist the updated session and broadcast `session-update` to other tabs.
 *
 * Never throws — all errors are captured as `degraded` status so the caller
 * can choose whether to prompt the user to reconnect.
 */
export async function recoverSession(): Promise<SessionRecoveryResult> {
  const session = loadStoredSession();

  if (!session) {
    return { status: "no_session", session: null };
  }

  if (isSessionExpired(session)) {
    clearStoredSession();
    return { status: "expired", session: null };
  }

  const EXTENSION_PROVIDERS: ExtensionWalletProviderId[] = ["freighter", "xbull", "albedo"];
  const isExtensionProvider = (EXTENSION_PROVIDERS as WalletProviderId[]).includes(
    session.providerId,
  );

  const recovered = { ...session };

  if (isExtensionProvider) {
    const adapter = getAdapter(session.providerId as ExtensionWalletProviderId);
    let available = false;
    try {
      available = adapter ? await adapter.isAvailable() : false;
    } catch {
      available = false;
    }

    recovered.providerAvailable = available;

    if (!available) {
      saveSession(recovered);
      return { status: "degraded", session: recovered };
    }
  } else {
    // Smart wallet — re-verify against backend if credentials are present
    const newStatus = await verifySmartWalletSession(session);
    recovered.verificationStatus = newStatus;
    if (newStatus === "verified") {
      recovered.lastVerifiedAt = new Date().toISOString();
      recovered.providerAvailable = true;
    } else {
      recovered.providerAvailable = false;
      saveSession(recovered);
      return { status: "degraded", session: recovered };
    }
  }

  recovered.lastActivityAt = new Date().toISOString();
  saveSession(recovered);
  return { status: "recovered", session: recovered };
}

export function isSessionExpired(session: WalletSession): boolean {
  if (!session.connectedAt) return false;
  const age = Date.now() - new Date(session.connectedAt).getTime();
  return age > SESSION_TTL_MS;
}

export function isSessionStale(session: WalletSession): boolean {
  if (!session.lastActivityAt) return true;
  const idle = Date.now() - new Date(session.lastActivityAt).getTime();
  return idle > STALE_THRESHOLD_MS;
}

export function clearStoredSession() {
  window.localStorage.removeItem(STORAGE_KEY);
  broadcastSessionEvent({ type: "disconnect", payload: null });
}

function saveSession(session: WalletSession) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  broadcastSessionEvent({ type: "session-update", payload: session });
}

function getProviderLabel(providerId: WalletProviderId) {
  return providerLabels[providerId];
}

function ensureIdentifier(providerId: WalletProviderId, identifier?: string) {
  const normalized = identifier?.trim().toLowerCase();
  if (!normalized) {
    throw new Error(
      providerId === "email"
        ? "Enter an email address to create a smart wallet session."
        : "Enter an email address or social handle to continue.",
    );
  }

  return normalized;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return window.btoa(binary);
}

async function deriveSmartWalletAddress(input: string) {
  const payload = new TextEncoder().encode(`stellar-yield:${input}`);
  const digest = await window.crypto.subtle.digest("SHA-256", payload);
  return StrKey.encodeContract(Buffer.from(digest));
}

async function verifySmartWalletSession(
  session: WalletSession,
): Promise<VerificationStatus> {
  if (!session.sessionKeyAddress || !session.sessionSecret) {
    return "degraded";
  }

  try {
    const challengeResponse = await fetch(`${getApiBaseUrl()}/api/auth/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        walletAddress: session.walletAddress,
        sessionKeyAddress: session.sessionKeyAddress,
        providerId: session.providerId,
        loginHint: session.loginHint,
      }),
    });

    if (!challengeResponse.ok) {
      throw new Error("Unable to create auth challenge.");
    }

    const challengePayload =
      (await challengeResponse.json()) as ChallengeResponse;
    const signer = Keypair.fromSecret(session.sessionSecret);
    const signature = bytesToBase64(
      signer.sign(Buffer.from(challengePayload.challenge, "utf8")),
    );

    const verificationResponse = await fetch(
      `${getApiBaseUrl()}/api/auth/verify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          walletAddress: session.walletAddress,
          sessionKeyAddress: session.sessionKeyAddress,
          challenge: challengePayload.challenge,
          signature,
        }),
      },
    );

    if (!verificationResponse.ok) {
      throw new Error("Unable to verify smart wallet session.");
    }

    const verificationPayload =
      (await verificationResponse.json()) as VerifyResponse;

    return verificationPayload.verified ? "verified" : "degraded";
  } catch (error) {
    console.warn("Smart wallet backend verification fell back to local mode", error);
    return "degraded";
  }
}

export async function connectWalletSession(
  options: ConnectWalletOptions = {},
): Promise<WalletSession> {
  const providerId = options.providerId ?? "freighter";
  const origin = createSessionOrigin();

  // ── Extension / browser wallet providers ───────────────────────────
  const EXTENSION_PROVIDERS: ExtensionWalletProviderId[] = ["freighter", "xbull", "albedo"];
  if ((EXTENSION_PROVIDERS as WalletProviderId[]).includes(providerId)) {
    const adapter = getAdapter(providerId as ExtensionWalletProviderId);
    if (!adapter) {
      throw new Error(`No adapter found for wallet provider: ${providerId}`);
    }

    let providerAvailable = true;
    try {
      providerAvailable = await adapter.isAvailable();
    } catch {
      providerAvailable = false;
    }
    if (!providerAvailable) {
      throw new Error(
        `${getProviderLabel(providerId)} extension is not available. ` +
        `Install it or check if it was disconnected from another tab.`,
      );
    }

    const walletAddress = await adapter.getPublicKey();
    const session: WalletSession = {
      walletAddress,
      walletAddressType: "account",
      providerId,
      providerLabel: getProviderLabel(providerId),
      verificationStatus: "verified",
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
      permissions: [...DEFAULT_PERMISSIONS, "trade"],
      origin,
      providerAvailable: true,
    };
    saveSession(session);
    return session;
  }

  const loginHint = ensureIdentifier(providerId, options.identifier);
  const sessionKey = Keypair.random();
  const walletAddress = await deriveSmartWalletAddress(
    `${providerId}:${loginHint}`,
  );

  const session: WalletSession = {
    walletAddress,
    walletAddressType: "contract",
    providerId,
    providerLabel: getProviderLabel(providerId),
    sessionKeyAddress: sessionKey.publicKey(),
    sessionSecret: sessionKey.secret(),
    loginHint,
    verificationStatus: "degraded",
    connectedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    permissions: [...DEFAULT_PERMISSIONS],
    origin,
    providerAvailable: true,
  };

  session.verificationStatus = await verifySmartWalletSession(session);
  if (session.verificationStatus === "verified") {
    session.lastVerifiedAt = new Date().toISOString();
  }
  saveSession(session);
  return session;
}
