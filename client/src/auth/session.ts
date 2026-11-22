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
  authConfigFingerprint?: string;
}

interface VerifyResponse {
  verified: boolean;
  walletAddressType: "account" | "contract";
  acceptedSignerTypes: string[];
  authConfigFingerprint?: string;
  /** Echo of the operation identity sent with the request (#1880). */
  operationId?: string;
  /** True when the server answered a safe retry from its recorded outcome. */
  replayed?: boolean;
}

/**
 * Generate a unique operation identity for one challenge verification.
 * The same id is reused when the identical request is retried, so the server
 * can answer the retry from its recorded outcome instead of rejecting it as a
 * challenge replay (#1880).
 */
export function createWalletOperationId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `wallet-verify-${cryptoApi.randomUUID()}`;
  }
  return `wallet-verify-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

/** Maximum number of times one verify request is sent with the same identity. */
export const VERIFY_SAFE_RETRY_ATTEMPTS = 2;

/**
 * POST one verification request, retrying transport failures and 5xx
 * responses with the exact same body and operation identity. Because the
 * identity is stable, a retry after a lost success response is answered with
 * the recorded outcome and never applies the verification twice.
 */
async function postVerifyWithSafeRetry(body: {
  walletAddress: string;
  sessionKeyAddress?: string;
  challenge: string;
  signature: string;
  operationId: string;
}): Promise<Response> {
  const serialized = JSON.stringify(body);
  let lastError: unknown;
  for (let attempt = 0; attempt < VERIFY_SAFE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/auth/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": body.operationId,
        },
        body: serialized,
      });
      if (response.status >= 500 && attempt + 1 < VERIFY_SAFE_RETRY_ATTEMPTS) {
        lastError = new Error(`verify responded ${response.status}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to verify smart wallet session.");
}

interface VerifyAttemptResult {
  status: VerificationStatus;
  authConfigFingerprint?: string;
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
let recoverInFlight: Promise<SessionRecoveryResult> | null = null;

export function recoverSession(): Promise<SessionRecoveryResult> {
  // Duplicate submissions (e.g. a double-mounted effect) share one in-flight
  // recovery so verification and persistence run only once.
  if (!recoverInFlight) {
    recoverInFlight = recoverSessionOnce().finally(() => {
      recoverInFlight = null;
    });
  }
  return recoverInFlight;
}

async function recoverSessionOnce(): Promise<SessionRecoveryResult> {
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
    // Smart wallet — re-verify against backend if credentials are present.
    // If the wallet auth configuration snapshot is stale, verification refreshes
    // and retries once; failures preserve the recovered session state as degraded.
    const verification = await verifySmartWalletSession(session);
    recovered.verificationStatus = verification.status;
    if (verification.authConfigFingerprint) {
      recovered.authConfigFingerprint = verification.authConfigFingerprint;
    }
    if (verification.status === "verified") {
      recovered.lastVerifiedAt = new Date().toISOString();
      recovered.providerAvailable = true;
    } else {
      recovered.providerAvailable = false;
      recovered.lastActivityAt = new Date().toISOString();
      saveSession(recovered);
      return { status: "degraded", session: recovered };
    }
  }

  recovered.lastActivityAt = new Date().toISOString();
  saveSession(recovered);
  return { status: "recovered", session: recovered };
}

/**
 * Elapsed milliseconds since an ISO timestamp, or `null` when the timestamp is
 * not a finite date (corrupted storage, tampered value).
 *
 * Negative values (timestamp in the future because of clock skew) are clamped
 * to zero so skew never makes a session look older than it is.
 */
function elapsedSince(timestamp: string): number | null {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return null;
  const elapsed = Date.now() - parsed;
  return elapsed < 0 ? 0 : elapsed;
}

/**
 * Boundary semantics: a session whose age is exactly `SESSION_TTL_MS` is still
 * valid; it expires one millisecond later. A missing `connectedAt` is treated
 * as not expired (legacy sessions), but an unparseable `connectedAt` fails
 * closed and is treated as expired.
 */
export function isSessionExpired(session: WalletSession): boolean {
  if (!session.connectedAt) return false;
  const age = elapsedSince(session.connectedAt);
  if (age === null) return true;
  return age > SESSION_TTL_MS;
}

/**
 * Boundary semantics: idle time exactly `STALE_THRESHOLD_MS` is still fresh.
 * A missing or unparseable `lastActivityAt` fails closed and is stale.
 */
export function isSessionStale(session: WalletSession): boolean {
  if (!session.lastActivityAt) return true;
  const idle = elapsedSince(session.lastActivityAt);
  if (idle === null) return true;
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

function isStaleWalletAuthConfigResponse(
  response: Response,
  payload: unknown,
): boolean {
  if (response.status !== 409) {
    return false;
  }
  return (
    typeof payload === "object" &&
    payload !== null &&
    "code" in payload &&
    (payload as { code?: unknown }).code === "STALE_WALLET_AUTH_CONFIG"
  );
}

async function requestSmartWalletChallenge(
  session: WalletSession,
): Promise<ChallengeResponse> {
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

  const challengePayload = (await challengeResponse.json()) as Partial<ChallengeResponse>;
  if (
    typeof challengePayload.challenge !== "string" ||
    !challengePayload.challenge.trim()
  ) {
    throw new Error("Unable to create auth challenge.");
  }

  return challengePayload as ChallengeResponse;
}

async function verifySmartWalletSession(
  session: WalletSession,
): Promise<VerifyAttemptResult> {
  if (!session.sessionKeyAddress || !session.sessionSecret) {
    return { status: "degraded", authConfigFingerprint: session.authConfigFingerprint };
  }

  try {
    const signer = Keypair.fromSecret(session.sessionSecret);
    let challengePayload = await requestSmartWalletChallenge(session);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const signature = bytesToBase64(
        signer.sign(Buffer.from(challengePayload.challenge, "utf8")),
      );

      // One operation identity per challenge: a fresh challenge is a new
      // operation, while transport retries of this request reuse the id.
      const verificationResponse = await postVerifyWithSafeRetry({
        walletAddress: session.walletAddress,
        sessionKeyAddress: session.sessionKeyAddress,
        challenge: challengePayload.challenge,
        signature,
        operationId: createWalletOperationId(),
      });

      let verificationPayload: Partial<VerifyResponse> & { code?: string } = {};
      try {
        verificationPayload = (await verificationResponse.json()) as Partial<VerifyResponse> & {
          code?: string;
        };
      } catch {
        verificationPayload = {};
      }

      if (
        isStaleWalletAuthConfigResponse(verificationResponse, verificationPayload) &&
        attempt === 0
      ) {
        // Safe retry: refresh work with a current configuration snapshot and
        // preserve existing session state on validation failure.
        challengePayload = await requestSmartWalletChallenge(session);
        continue;
      }

      if (!verificationResponse.ok) {
        throw new Error("Unable to verify smart wallet session.");
      }

      if (typeof verificationPayload.verified !== "boolean") {
        throw new Error("Unable to verify smart wallet session.");
      }

      const authConfigFingerprint =
        (typeof verificationPayload.authConfigFingerprint === "string" &&
          verificationPayload.authConfigFingerprint) ||
        (typeof challengePayload.authConfigFingerprint === "string" &&
          challengePayload.authConfigFingerprint) ||
        session.authConfigFingerprint;

      return {
        status: verificationPayload.verified ? "verified" : "degraded",
        authConfigFingerprint,
      };
    }

    return { status: "degraded", authConfigFingerprint: session.authConfigFingerprint };
  } catch {
    console.warn("[wallet] lifecycle diagnostic", {
      stage: "backend_verification",
      remediation: WALLET_LIFECYCLE_DIAGNOSTICS.backend_verification.remediation,
    });
    return { status: "degraded", authConfigFingerprint: session.authConfigFingerprint };
  }
}

function isExtensionProvider(
  providerId: WalletProviderId,
): providerId is ExtensionWalletProviderId {
  return providerId === "freighter" || providerId === "xbull" || providerId === "albedo";
}

/**
 * In-flight connect operations keyed by operation identity
 * (provider + normalised identifier). See {@link connectWalletSession}.
 */
const connectInFlight = new Map<string, Promise<WalletSession>>();

export function getConnectOperationKey(options: ConnectWalletOptions = {}): string {
  const providerId = options.providerId ?? "freighter";
  if (isExtensionProvider(providerId)) {
    return providerId;
  }
  return `${providerId}:${options.identifier?.trim().toLowerCase() ?? ""}`;
}

/**
 * Connect a wallet and persist the resulting session.
 *
 * Duplicate submissions (double clicks, repeated Enter presses, re-rendered
 * effects) for the same operation identity share a single in-flight
 * operation: the provider is prompted once, one session key is generated, one
 * verification is performed and the session is persisted once. Every caller
 * receives the same session. Once the operation settles, a new call starts a
 * fresh attempt, so retrying after a failure is always possible. A failure
 * never replaces the previously persisted session (#1880).
 */
export function connectWalletSession(
  options: ConnectWalletOptions = {},
): Promise<WalletSession> {
  const key = getConnectOperationKey(options);
  const existing = connectInFlight.get(key);
  if (existing) {
    return existing;
  }
  const operation = connectWalletSessionOnce(options).finally(() => {
    connectInFlight.delete(key);
  });
  connectInFlight.set(key, operation);
  return operation;
}

async function connectWalletSessionOnce(
  options: ConnectWalletOptions,
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

  const verification = await verifySmartWalletSession(session);
  session.verificationStatus = verification.status;
  if (verification.authConfigFingerprint) {
    session.authConfigFingerprint = verification.authConfigFingerprint;
  }
  if (verification.status === "verified") {
    session.lastVerifiedAt = new Date().toISOString();
  }
  // Persist the session snapshot only after verification/refresh completes.
  // Stale wallet-auth config responses trigger a fresh challenge retry above and
  // never mutate previously persisted wallet sessions during this connect flow.
  saveSession(session);
  return session;
}
