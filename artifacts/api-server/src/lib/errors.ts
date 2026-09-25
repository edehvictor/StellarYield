import type {
  AccountLinkError as AccountLinkErrorPayload,
  AccountLinkErrorErrorCode,
  AccountLinkErrorErrorDetailsItem,
} from "@workspace/api-zod";

/**
 * Stable error codes shared with the OpenAPI contract
 * (`AccountLinkError.error.code`). Every failure path must map onto one of
 * these codes so clients never have to parse raw database or SDK messages.
 */
export type AccountLinkErrorCodeType = AccountLinkErrorErrorCode;

export type AccountLinkErrorDetail = AccountLinkErrorErrorDetailsItem;

/** Stable, serializable error body returned by every failure path. */
export interface AccountLinkErrorBody extends AccountLinkErrorPayload {}

export interface AccountLinkErrorOptions {
  /** Original failure, kept for server-side logging only; never serialized. */
  readonly cause?: unknown;
  /** Per-field validation details, when applicable. */
  readonly details?: readonly AccountLinkErrorDetail[];
}

/**
 * Application error that always serializes to the stable typed payload
 * declared in the OpenAPI `AccountLinkError` schema. Raw provider or SDK
 * errors are only ever attached as `cause` for logging.
 */
export class AccountLinkError extends Error {
  public readonly code: AccountLinkErrorCodeType;
  public readonly status: number;
  public readonly details?: readonly AccountLinkErrorDetail[];

  constructor(
    status: number,
    code: AccountLinkErrorCodeType,
    message: string,
    options: AccountLinkErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AccountLinkError";
    this.code = code;
    this.status = status;
    this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serializes to the stable typed payload shared by all failure routes. */
  public toBody(): AccountLinkErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details
          ? { details: this.details.map((detail) => ({ ...detail })) }
          : {}),
      },
    };
  }

  /** 400 - request body failed schema validation. */
  public static invalidRequest(
    details: readonly AccountLinkErrorDetail[],
  ): AccountLinkError {
    return new AccountLinkError(
      400,
      "INVALID_REQUEST",
      "Request validation failed.",
      { details },
    );
  }

  /** 400 - the explicitly expected public key field is absent or blank. */
  public static missingPublicKey(): AccountLinkError {
    return new AccountLinkError(
      400,
      "MISSING_PUBLIC_KEY",
      "publicKey is required to link a Stellar account.",
    );
  }

  /** 400 - a public key was supplied but failed StrKey validation. */
  public static invalidPublicKey(detailMessage: string): AccountLinkError {
    return new AccountLinkError(
      400,
      "INVALID_PUBLIC_KEY",
      "publicKey is not a valid Stellar public key.",
      { details: [{ path: "publicKey", message: detailMessage }] },
    );
  }

  /** 503 - account storage failed; the raw cause is logged, never returned. */
  public static accountServiceUnavailable(cause: unknown): AccountLinkError {
    return new AccountLinkError(
      503,
      "ACCOUNT_SERVICE_UNAVAILABLE",
      "Stellar account storage is temporarily unavailable. Please retry.",
      { cause },
    );
  }

  /** 500 - unexpected failure; the raw cause is logged, never returned. */
  public static internal(cause: unknown): AccountLinkError {
    return new AccountLinkError(
      500,
      "INTERNAL_SERVER_ERROR",
      "An unexpected error occurred.",
      { cause },
    );
  }
}
