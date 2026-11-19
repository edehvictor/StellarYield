/**
 * Typed recovery model for rejected wallet signatures (#1363).
 *
 * Wallet providers report a declined signature request in provider-specific
 * ways (Freighter returns `{ error }`, xBull/Albedo throw, the SDK wraps the
 * reason in `WalletRejectedError`). Those raw strings are useful for detection
 * but must never be shown to the user as-is: they leak provider internals and
 * change without notice.
 *
 * This module reduces any signing failure to a stable, machine-readable
 * `WalletSignatureRejectionCode` plus deterministic copy and a list of recovery
 * actions. It is shared by the client recovery flow and the server telemetry
 * endpoint so both layers agree on the vocabulary.
 *
 * Pure and dependency-free: safe to import from a browser bundle or Node.
 */

/** Stable machine-readable codes for a failed signature request. */
export type WalletSignatureRejectionCode =
  /** The user declined the request in their wallet (or closed the prompt). */
  | "USER_REJECTED_SIGNATURE"
  /** The wallet is locked and needs the user to unlock it. */
  | "WALLET_LOCKED"
  /** The wallet extension/app is not connected, installed, or was closed. */
  | "WALLET_DISCONNECTED"
  /** The connected wallet cannot sign transactions (e.g. a smart-wallet session). */
  | "WALLET_UNSUPPORTED"
  /** The signature request did not receive a response before the deadline. */
  | "SIGNING_TIMEOUT"
  /** The wallet responded, but without a usable signed transaction. */
  | "MALFORMED_SIGNATURE_RESPONSE"
  /** A signing failure that does not match any known provider behaviour. */
  | "UNKNOWN_SIGNING_FAILURE";

/** Actions the recovery UI can offer for a rejected signature. */
export type SignatureRecoveryAction =
  /** Rebuild the transaction and ask the wallet for a fresh signature. */
  | "retry"
  /** Reconnect / re-authorise the wallet, then retry. */
  | "reconnect"
  /** Use a different wallet that supports transaction signing. */
  | "switch_wallet"
  /** Leave the flow without retrying; nothing was submitted. */
  | "cancel";

/** A fully resolved rejection, safe to render and to send over the wire. */
export interface WalletSignatureRejection {
  code: WalletSignatureRejectionCode;
  /** Short heading for a recovery panel. */
  title: string;
  /** Deterministic explanation. Never a raw provider message. */
  message: string;
  /** What the user can do next. */
  guidance: string;
  /** True when another signature request may succeed. */
  retryable: boolean;
  /** 1-based count of signature attempts for the current action. */
  attempt: number;
  maxAttempts: number;
  remainingAttempts: number;
  /** Ordered actions the UI should offer. */
  actions: SignatureRecoveryAction[];
  /** Wallet provider id when known (e.g. `freighter`), for telemetry only. */
  provider?: string;
}

export interface SignatureRejectionContext {
  /** 1-based attempt number. Defaults to 1. */
  attempt?: number;
  /** Attempts allowed before the flow recommends switching wallets. Defaults to 3. */
  maxAttempts?: number;
  /** Wallet provider id, copied into the result for telemetry. */
  provider?: string;
}

export const DEFAULT_MAX_SIGNATURE_ATTEMPTS = 3;

export const SIGNATURE_REJECTION_COPY: Record<
  WalletSignatureRejectionCode,
  Pick<WalletSignatureRejection, "title" | "message" | "guidance">
> = {
  USER_REJECTED_SIGNATURE: {
    title: "Signature request declined",
    message:
      "Your wallet declined the signature request, so nothing was sent to the network.",
    guidance:
      "Review the transaction, then retry and approve the signature request in your wallet.",
  },
  WALLET_LOCKED: {
    title: "Wallet is locked",
    message: "Your wallet is locked and cannot sign the transaction.",
    guidance: "Unlock your wallet, then retry the signature request.",
  },
  WALLET_DISCONNECTED: {
    title: "Wallet is disconnected",
    message: "Your wallet is not connected, so the transaction cannot be signed.",
    guidance: "Reconnect your wallet, then retry the signature request.",
  },
  WALLET_UNSUPPORTED: {
    title: "This wallet cannot sign transactions",
    message:
      "The connected wallet does not support transaction signing for this action.",
    guidance: "Switch to a wallet that supports transaction signing, then retry.",
  },
  SIGNING_TIMEOUT: {
    title: "Signature request timed out",
    message: "Your wallet did not respond to the signature request in time.",
    guidance: "Retry to send a fresh signature request to your wallet.",
  },
  MALFORMED_SIGNATURE_RESPONSE: {
    title: "Wallet returned an invalid signature",
    message:
      "Your wallet responded without a usable signed transaction, so nothing was submitted.",
    guidance:
      "Retry the signature request. If it keeps happening, switch wallets.",
  },
  UNKNOWN_SIGNING_FAILURE: {
    title: "Signature request could not be completed",
    message: "The wallet signature request failed and nothing was submitted.",
    guidance:
      "Retry with a fresh signature request. If the problem persists, switch wallets or contact support.",
  },
};

/** Actions offered for each code, before the attempt limit is applied. */
const ACTIONS_BY_CODE: Record<WalletSignatureRejectionCode, SignatureRecoveryAction[]> = {
  USER_REJECTED_SIGNATURE: ["retry", "switch_wallet", "cancel"],
  WALLET_LOCKED: ["retry", "reconnect", "cancel"],
  WALLET_DISCONNECTED: ["reconnect", "retry", "cancel"],
  WALLET_UNSUPPORTED: ["switch_wallet", "cancel"],
  SIGNING_TIMEOUT: ["retry", "reconnect", "cancel"],
  MALFORMED_SIGNATURE_RESPONSE: ["retry", "switch_wallet", "cancel"],
  UNKNOWN_SIGNING_FAILURE: ["retry", "switch_wallet", "cancel"],
};

/**
 * Errors that can never be fixed by retrying the same operation.
 * They still expose recovery actions, but `retryable` is false and `retry` is
 * never offered.
 */
const NON_RETRYABLE_CODES = new Set<WalletSignatureRejectionCode>([
  "WALLET_UNSUPPORTED",
]);

const REJECTION_PATTERNS: Array<{
  code: WalletSignatureRejectionCode;
  pattern: RegExp;
}> = [
  {
    code: "WALLET_UNSUPPORTED",
    pattern:
      /not supported for smart wallet|does not support (?:transaction )?signing|unsupported wallet|signing is not supported/i,
  },
  {
    code: "WALLET_LOCKED",
    pattern: /wallet is locked|wallet locked|unlock (?:your )?wallet|locked wallet/i,
  },
  {
    code: "WALLET_DISCONNECTED",
    pattern:
      /no wallet connected|wallet (?:is )?not connected|not connected|wallet.*not (?:installed|detected|available)|extension.*not (?:installed|detected|available)|no adapter for provider|freighter wallet is not installed|failed to connect/i,
  },
  {
    code: "SIGNING_TIMEOUT",
    pattern: /signing.*timed? ?out|timed? ?out.*sign|wallet did not respond|request timed out/i,
  },
  {
    code: "MALFORMED_SIGNATURE_RESPONSE",
    pattern:
      /empty signed|did not return a signed|unsupported signing response|malformed|invalid signed|no signed (?:tx|xdr|transaction)/i,
  },
  {
    code: "USER_REJECTED_SIGNATURE",
    pattern:
      /user (?:declined|rejected|denied)|declined|rejected|rejection|cancelled|canceled|denied|dismissed|refused|user closed|prompt closed/i,
  },
];

/** True when `value` looks like a wallet signing failure. */
export function isWalletSignatureRejection(value: unknown): boolean {
  if (value instanceof WalletSignatureRejectionError) return true;
  if (value && typeof value === "object") {
    const name = (value as { name?: unknown }).name;
    if (name === "WalletRejectedError" || name === "WalletSignatureRejectionError") {
      return true;
    }
  }

  const text =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "";
  if (!text) return false;

  // The SDK wraps every signer failure as `Wallet rejected signature: ...`,
  // including provider outages. Treat only the wrapping plus a known reason
  // pattern as a signature rejection.
  const withoutSdkPrefix = text.replace(/^wallet rejected signature:\s*/i, "");
  return REJECTION_PATTERNS.some(({ pattern }) => pattern.test(withoutSdkPrefix));
}

/** Build a rejection directly from a known code (server/telemetry paths). */
export function createSignatureRejection(
  code: WalletSignatureRejectionCode,
  context: SignatureRejectionContext = {},
): WalletSignatureRejection {
  return buildRejection(
    code,
    normalizeAttempt(context.attempt),
    normalizeAttemptLimit(context.maxAttempts),
    normalizeProvider(context.provider),
  );
}

/** Classify a provider/SDK error into stable copy and recovery actions. */
export function classifyWalletSignatureError(
  error: unknown,
  context: SignatureRejectionContext = {},
): WalletSignatureRejection {
  const maxAttempts = normalizeAttemptLimit(context.maxAttempts);
  const attempt = normalizeAttempt(context.attempt);
  const provider = normalizeProvider(context.provider);

  if (error instanceof WalletSignatureRejectionError) {
    return buildRejection(error.code, attempt, maxAttempts, provider ?? error.provider);
  }

  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  const normalized = text.replace(/^wallet rejected signature:\s*/i, "");
  const match = REJECTION_PATTERNS.find(({ pattern }) => pattern.test(normalized));

  return buildRejection(
    match?.code ?? "UNKNOWN_SIGNING_FAILURE",
    attempt,
    maxAttempts,
    provider,
  );
}

function buildRejection(
  code: WalletSignatureRejectionCode,
  attempt: number,
  maxAttempts: number,
  provider?: string,
): WalletSignatureRejection {
  const exhausted = attempt >= maxAttempts && !NON_RETRYABLE_CODES.has(code);
  const retryable = !exhausted && !NON_RETRYABLE_CODES.has(code);
  const copy = SIGNATURE_REJECTION_COPY[code];

  const actions = ACTIONS_BY_CODE[code].filter((action) => {
    if (action === "retry") return retryable;
    return true;
  });

  const guidance = exhausted
    ? `${copy.guidance} You have reached ${maxAttempts} signing attempts; switch wallets or contact support before trying again.`
    : copy.guidance;

  return {
    code,
    title: copy.title,
    message: copy.message,
    guidance,
    retryable,
    attempt,
    maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - attempt),
    actions,
    ...(provider ? { provider } : {}),
  };
}

function normalizeAttempt(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 1;
  return Math.min(99, Math.max(1, Math.floor(value)));
}

function normalizeAttemptLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_MAX_SIGNATURE_ATTEMPTS;
  }
  return Math.min(99, Math.max(1, Math.floor(value)));
}

function normalizeProvider(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Typed error for callers that want to throw instead of returning a result.
 * `message` is always the stable user-facing copy — the provider's text is
 * kept only on `cause` for logging.
 */
export class WalletSignatureRejectionError extends Error {
  readonly code: WalletSignatureRejectionCode;
  readonly rejection: WalletSignatureRejection;
  readonly provider?: string;
  readonly cause?: unknown;

  constructor(
    rejection: WalletSignatureRejection,
    options: { cause?: unknown } = {},
  ) {
    super(rejection.message);
    this.name = "WalletSignatureRejectionError";
    this.code = rejection.code;
    this.rejection = rejection;
    this.provider = rejection.provider;
    this.cause = options.cause;
  }

  static from(error: unknown, context: SignatureRejectionContext = {}) {
    return new WalletSignatureRejectionError(
      classifyWalletSignatureError(error, context),
      { cause: error },
    );
  }
}
