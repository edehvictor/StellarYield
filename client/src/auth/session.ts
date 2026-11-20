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

export type WalletLifecycleStage =
  | "provider_availability"
  | "wallet_authorization"
  | "address_validation"
  | "identifier_validation"
  | "smart_wallet_preparation"
  | "backend_verification"
  | "session_restore"
  | "session_persistence"
  | "transaction_signing";

const WALLET_LIFECYCLE_DIAGNOSTICS: Record<
  WalletLifecycleStage,
  { label: string; remediation: string }
> = {
  provider_availability: {
    label: "wallet availability",
    remediation: "Install or unlock the selected wallet, then retry.",
  },
  wallet_authorization: {
    label: "wallet authorization",
    remediation: "Approve the connection request in your wallet, then retry.",
  },
  address_validation: {
    label: "wallet address validation",
    remediation: "Select a valid Stellar account in your wallet, then reconnect.",
  },
  identifier_validation: {
    label: "smart wallet input validation",
    remediation: "Enter the requested email address or social handle, then retry.",
  },
  smart_wallet_preparation: {
    label: "smart wallet preparation",
    remediation: "Check browser support and retry the smart wallet connection.",
  },
  backend_verification: {
    label: "smart wallet verification",
    remediation: "The session is in local-only mode; retry verification when the service is available.",
  },
  session_restore: {
    label: "session restoration",
    remediation: "Reconnect your wallet to create a fresh session.",
  },
  session_persistence: {
    label: "session persistence",
    remediation: "Enable browser storage and retry; the previous wallet session was kept.",
  },
  transaction_signing: {
    label: "transaction signing",
    remediation: "Unlock your wallet and approve the signing request, then retry.",
  },
};

export class WalletLifecycleError extends Error {
  readonly stage: WalletLifecycleStage;
  readonly remediation: string;

  constructor(stage: WalletLifecycleStage) {
    const diagnostic = WALLET_LIFECYCLE_DIAGNOSTICS[stage];
    super(`Wallet lifecycle failed during ${diagnostic.label}. ${diagnostic.remediation}`);
    this.name = "WalletLifecycleError";
    this.stage = stage;
    this.remediation = diagnostic.remediation;
  }
}

export function getWalletLifecycleStageDiagnostic(stage: WalletLifecycleStage) {
  const diagnostic = WALLET_LIFECYCLE_DIAGNOSTICS[stage];
  return {
    stage,
    remediation: diagnostic.remediation,
    message: `Wallet lifecycle failed during ${diagnostic.label}. ${diagnostic.remediation}`,
  };
}

export function getWalletLifecycleDiagnostic(error: unknown): {
  stage: WalletLifecycleStage | "unknown";
  remediation: string;
  message: string;
} {
  if (error instanceof WalletLifecycleError) {
    return getWalletLifecycleStageDiagnostic(error.stage);
  }

  const remediation = "Retry the wallet operation. If it continues, contact support.";
  return {
    stage: "unknown",
    remediation,
    message: `Wallet lifecycle failed. ${remediation}`,
  };
}

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
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    const diagnostic = getWalletLifecycleStageDiagnostic("session_restore");
    console.warn("[wallet] lifecycle diagnostic", {
      stage: diagnostic.stage,
      remediation: diagnostic.remediation,
    });
    return null;
  }
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
  } catch {
    const diagnostic = getWalletLifecycleStageDiagnostic("session_restore");
    console.warn("[wallet] lifecycle diagnostic", {
      stage: diagnostic.stage,
      remediation: diagnostic.remediation,
    });
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
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    throw new WalletLifecycleError("session_persistence");
  }

  try {
    broadcastSessionEvent({ type: "session-update", payload: session });
  } catch {
    console.warn("[wallet] lifecycle diagnostic", {
      stage: "session_persistence",
      remediation: "Session was saved, but other tabs may need to reload.",
    });
  }
}

function getProviderLabel(providerId: WalletProviderId) {
  return providerLabels[providerId];
}

function ensureIdentifier(identifier?: string) {
  const normalized = identifier?.trim().toLowerCase();
  if (!normalized) {
    throw new WalletLifecycleError("identifier_validation");
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
      (await challengeResponse.json()) as Partial<ChallengeResponse>;
    if (
      typeof challengePayload.challenge !== "string" ||
      !challengePayload.challenge.trim()
    ) {
      throw new Error();
    }
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
      (await verificationResponse.json()) as Partial<VerifyResponse>;
    if (typeof verificationPayload.verified !== "boolean") {
      throw new Error();
    }

    return verificationPayload.verified ? "verified" : "degraded";
  } catch {
    console.warn("[wallet] lifecycle diagnostic", {
      stage: "backend_verification",
      remediation: WALLET_LIFECYCLE_DIAGNOSTICS.backend_verification.remediation,
    });
    return "degraded";
  }
}

function isExtensionProvider(
  providerId: WalletProviderId,
): providerId is ExtensionWalletProviderId {
  return providerId === "freighter" || providerId === "xbull" || providerId === "albedo";
}

export async function connectWalletSession(
  options: ConnectWalletOptions = {},
): Promise<WalletSession> {
  const providerId = options.providerId ?? "freighter";
  const origin = createSessionOrigin();

  // ── Extension / browser wallet providers ───────────────────────────
  if (isExtensionProvider(providerId)) {
    const adapter = getAdapter(providerId);
    if (!adapter) {
      throw new WalletLifecycleError("provider_availability");
    }

    let providerAvailable = true;
    try {
      providerAvailable = await adapter.isAvailable();
    } catch {
      throw new WalletLifecycleError("provider_availability");
    }
    if (!providerAvailable) {
      throw new WalletLifecycleError("provider_availability");
    }

    let walletAddress: string;
    try {
      walletAddress = await adapter.getPublicKey();
    } catch {
      throw new WalletLifecycleError("wallet_authorization");
    }
    if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
      throw new WalletLifecycleError("address_validation");
    }

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

  const loginHint = ensureIdentifier(options.identifier);
  let sessionKey: Keypair;
  let walletAddress: string;
  try {
    sessionKey = Keypair.random();
    walletAddress = await deriveSmartWalletAddress(
      `${providerId}:${loginHint}`,
    );
  } catch {
    throw new WalletLifecycleError("smart_wallet_preparation");
  }

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
