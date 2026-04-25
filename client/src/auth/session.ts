import { Buffer } from "buffer";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type {
  ConnectWalletOptions,
  ExtensionWalletProviderId,
  VerificationStatus,
  WalletProviderId,
  WalletSession,
} from "./types";
import { getAdapter } from "./walletAdapters";
import { getApiBaseUrl } from "../lib/api";

const STORAGE_KEY = "stellar-yield.wallet-session";
const API_BASE_URL = getApiBaseUrl();

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
    return JSON.parse(stored) as WalletSession;
  } catch (error) {
    console.error("Failed to restore wallet session", error);
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearStoredSession() {
  window.localStorage.removeItem(STORAGE_KEY);
}

function saveSession(session: WalletSession) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
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
    const challengeResponse = await fetch(`${API_BASE_URL}/api/auth/challenge`, {
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
      `${API_BASE_URL}/api/auth/verify`,
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

  // ── Extension / browser wallet providers ───────────────────────────
  const EXTENSION_PROVIDERS: ExtensionWalletProviderId[] = ["freighter", "xbull", "albedo"];
  if ((EXTENSION_PROVIDERS as WalletProviderId[]).includes(providerId)) {
    const adapter = getAdapter(providerId as ExtensionWalletProviderId);
    if (!adapter) {
      throw new Error(`No adapter found for wallet provider: ${providerId}`);
    }
    const walletAddress = await adapter.getPublicKey();
    const session: WalletSession = {
      walletAddress,
      walletAddressType: "account",
      providerId,
      providerLabel: getProviderLabel(providerId),
      verificationStatus: "verified",
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
  };

  session.verificationStatus = await verifySmartWalletSession(session);
  saveSession(session);
  return session;
}
