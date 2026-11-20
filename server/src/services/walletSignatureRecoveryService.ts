/**
 * Wallet signature rejection recovery service (#1363).
 *
 * The client classifies a rejected signature locally so recovery works offline.
 * This service provides the same stable vocabulary server-side: it validates
 * telemetry payloads, records non-sensitive rejection events, and returns the
 * recovery guidance support tooling can rely on. Raw provider messages are used
 * only for classification and are never stored or echoed.
 */

import {
  classifyWalletSignatureError,
  createSignatureRejection,
  DEFAULT_MAX_SIGNATURE_ATTEMPTS,
  type WalletSignatureRejection,
  type WalletSignatureRejectionCode,
} from "../../../shared/types/walletSignatureRejection";

export const SIGNATURE_REJECTION_CODES: readonly WalletSignatureRejectionCode[] = [
  "USER_REJECTED_SIGNATURE",
  "WALLET_LOCKED",
  "WALLET_DISCONNECTED",
  "WALLET_UNSUPPORTED",
  "SIGNING_TIMEOUT",
  "MALFORMED_SIGNATURE_RESPONSE",
  "UNKNOWN_SIGNING_FAILURE",
];

export interface SignatureRejectionRequest {
  walletAddress?: unknown;
  provider?: unknown;
  action?: unknown;
  code?: unknown;
  reason?: unknown;
  attempt?: unknown;
  maxAttempts?: unknown;
  completedSteps?: unknown;
  totalSteps?: unknown;
}

export interface SignatureRejectionEvent {
  code: WalletSignatureRejectionCode;
  walletAddress: string | null;
  provider: string | null;
  action: string;
  attempt: number;
  completedSteps: number | null;
  totalSteps: number | null;
  recordedAt: string;
}

export interface SignatureRejectionResponse extends WalletSignatureRejection {
  recordedAt: string;
}

export interface SignatureRejectionSummary {
  wallet: string | null;
  total: number;
  byCode: Partial<Record<WalletSignatureRejectionCode, number>>;
  topAction: string | null;
  lastOccurredAt: string | null;
}

export type SignatureRejectionErrorCode =
  | "INVALID_ACTION"
  | "INVALID_REJECTION_CODE"
  | "INVALID_ATTEMPT"
  | "INVALID_PROVIDER"
  | "INVALID_WALLET_ADDRESS"
  | "INVALID_PROGRESS"
  | "INVALID_REASON";

export class SignatureRejectionValidationError extends Error {
  readonly code: SignatureRejectionErrorCode;
  readonly statusCode = 400;
  readonly details: Array<{ field: string; code: string; message: string }>;

  constructor(
    code: SignatureRejectionErrorCode,
    field: string,
    message: string,
  ) {
    super(message);
    this.name = "SignatureRejectionValidationError";
    this.code = code;
    this.details = [{ field, code, message }];
  }
}

type StoredEvent = SignatureRejectionEvent;

const MAX_STORED_EVENTS = 500;
const events: StoredEvent[] = [];

/**
 * Validate and record a rejection. Throws `SignatureRejectionValidationError`
 * for malformed payloads so the route can return a typed 400.
 */
export function recordSignatureRejection(
  input: SignatureRejectionRequest,
): SignatureRejectionResponse {
  const action = requireAction(input.action);
  const walletAddress = optionalString(
    input.walletAddress,
    "walletAddress",
    "INVALID_WALLET_ADDRESS",
    128,
  );
  const provider = optionalString(
    input.provider,
    "provider",
    "INVALID_PROVIDER",
    32,
  );
  const attempt = optionalInteger(input.attempt, "attempt", "INVALID_ATTEMPT", 1);
  const maxAttempts = optionalInteger(
    input.maxAttempts,
    "maxAttempts",
    "INVALID_ATTEMPT",
    1,
  );
  const completedSteps = optionalInteger(
    input.completedSteps,
    "completedSteps",
    "INVALID_PROGRESS",
    0,
  );
  const totalSteps = optionalInteger(
    input.totalSteps,
    "totalSteps",
    "INVALID_PROGRESS",
    0,
  );

  if (
    completedSteps !== undefined &&
    totalSteps !== undefined &&
    completedSteps > totalSteps
  ) {
    throw new SignatureRejectionValidationError(
      "INVALID_PROGRESS",
      "completedSteps",
      "completedSteps must not exceed totalSteps.",
    );
  }

  const code = parseCode(input.code);
  const reason =
    input.reason === undefined
      ? undefined
      : optionalString(input.reason, "reason", "INVALID_REASON", 500);

  const context = {
    attempt: attempt ?? 1,
    maxAttempts: maxAttempts ?? DEFAULT_MAX_SIGNATURE_ATTEMPTS,
    provider,
  };

  let rejection: WalletSignatureRejection;
  if (code) {
    rejection = createSignatureRejection(code, context);
  } else if (reason) {
    rejection = classifyWalletSignatureError(reason, context);
  } else {
    rejection = createSignatureRejection("USER_REJECTED_SIGNATURE", context);
  }

  const recordedAt = new Date().toISOString();
  const event: StoredEvent = {
    code: rejection.code,
    walletAddress: walletAddress ?? null,
    provider: provider ?? null,
    action,
    attempt: rejection.attempt,
    completedSteps: completedSteps ?? null,
    totalSteps: totalSteps ?? null,
    recordedAt,
  };

  events.push(event);
  if (events.length > MAX_STORED_EVENTS) events.shift();

  return { ...rejection, recordedAt };
}

/** Aggregate rejection counts for support/observability. */
export function getSignatureRejectionSummary(
  walletAddress?: string,
): SignatureRejectionSummary {
  const wallet =
    typeof walletAddress === "string" && walletAddress.trim()
      ? walletAddress.trim()
      : null;
  const matching = wallet
    ? events.filter((event) => event.walletAddress === wallet)
    : events;

  const byCode: Partial<Record<WalletSignatureRejectionCode, number>> = {};
  const actionCounts = new Map<string, number>();

  for (const event of matching) {
    byCode[event.code] = (byCode[event.code] ?? 0) + 1;
    actionCounts.set(event.action, (actionCounts.get(event.action) ?? 0) + 1);
  }

  let topAction: string | null = null;
  let topCount = 0;
  for (const [action, count] of actionCounts) {
    if (count > topCount) {
      topAction = action;
      topCount = count;
    }
  }

  return {
    wallet,
    total: matching.length,
    byCode,
    topAction,
    lastOccurredAt:
      matching.length > 0 ? matching[matching.length - 1].recordedAt : null,
  };
}

/** True when `value` is one of the shared rejection codes. */
export function isSignatureRejectionCode(
  value: unknown,
): value is WalletSignatureRejectionCode {
  return (
    typeof value === "string" &&
    (SIGNATURE_REJECTION_CODES as readonly string[]).includes(value)
  );
}

/** Test helper — clears recorded events. */
export function _resetSignatureRejectionStore(): void {
  events.length = 0;
}

function requireAction(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SignatureRejectionValidationError(
      "INVALID_ACTION",
      "action",
      "action is required and must be a non-empty string.",
    );
  }
  const action = value.trim();
  if (action.length > 80) {
    throw new SignatureRejectionValidationError(
      "INVALID_ACTION",
      "action",
      "action must be 80 characters or fewer.",
    );
  }
  return action;
}

function optionalString(
  value: unknown,
  field: string,
  code: SignatureRejectionErrorCode,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new SignatureRejectionValidationError(
      code,
      field,
      `${field} must be a string of ${maxLength} characters or fewer.`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalInteger(
  value: unknown,
  field: string,
  code: SignatureRejectionErrorCode,
  minimum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 99
  ) {
    throw new SignatureRejectionValidationError(
      code,
      field,
      `${field} must be an integer between ${minimum} and 99.`,
    );
  }
  return value;
}

function parseCode(value: unknown): WalletSignatureRejectionCode | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isSignatureRejectionCode(value)) {
    throw new SignatureRejectionValidationError(
      "INVALID_REJECTION_CODE",
      "code",
      `code must be one of: ${SIGNATURE_REJECTION_CODES.join(", ")}.`,
    );
  }
  return value;
}

