import type {
  ApiError as ApiErrorPayload,
  ApiErrorErrorCode,
  ApiErrorErrorDetailsItem,
} from "@workspace/api-zod";

/**
 * Stable error codes shared with the OpenAPI contract (`ApiError.error.code`).
 * Every failure path must map onto one of these codes so clients never have
 * to parse raw database or network provider messages.
 */
export type ApiErrorCode = ApiErrorErrorCode;

export type ApiErrorDetail = ApiErrorErrorDetailsItem;

/** Stable, serializable error body returned by every failure path. */
export interface ApiErrorBody extends ApiErrorPayload {}

export interface ApiErrorOptions {
  /** Original failure, kept for server-side logging only; never serialized. */
  readonly cause?: unknown;
  /** Per-field validation details, when applicable. */
  readonly details?: readonly ApiErrorDetail[];
}

/**
 * Application error that always serializes to the stable typed payload
 * declared in the OpenAPI `ApiError` schema. Raw provider errors are only
 * ever attached as `cause` for logging and are never exposed to clients.
 */
export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details?: readonly ApiErrorDetail[];

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serializes to the stable typed payload shared by all failure routes. */
  public toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details.map((detail) => ({ ...detail })) } : {}),
      },
    };
  }

  /** 400 — request body failed schema validation. */
  public static invalidRequest(details: readonly ApiErrorDetail[]): ApiError {
    return new ApiError(400, "INVALID_REQUEST", "Request validation failed.", {
      details,
    });
  }

  /** 401 — no client identifier was supplied on the request. */
  public static missingClientIdentifier(): ApiError {
    return new ApiError(
      401,
      "MISSING_CLIENT_IDENTIFIER",
      "A client identifier must be provided in the x-client-id header.",
    );
  }

  /** 401 — a client identifier was supplied but does not satisfy the contract. */
  public static invalidClientIdentifier(): ApiError {
    return new ApiError(
      401,
      "INVALID_CLIENT_IDENTIFIER",
      "The provided x-client-id header is not a valid client identifier.",
    );
  }

  /** 404 — the intent does not exist or has already been cleared. */
  public static intentNotFound(): ApiError {
    return new ApiError(
      404,
      "INTENT_NOT_FOUND",
      "Transaction intent was not found.",
    );
  }

  /** 403 — the intent exists but belongs to a different client. */
  public static intentClientMismatch(): ApiError {
    return new ApiError(
      403,
      "INTENT_CLIENT_MISMATCH",
      "Transaction intent does not belong to this client.",
    );
  }

  /** 409 — the intent left the pending state before/while cancelling. */
  public static intentAlreadyProcessed(): ApiError {
    return new ApiError(
      409,
      "INTENT_ALREADY_PROCESSED",
      "Transaction intent is no longer pending and cannot be cancelled.",
    );
  }

  /** 503 — intent storage failed; the raw cause is logged, never returned. */
  public static intentServiceUnavailable(cause: unknown): ApiError {
    return new ApiError(
      503,
      "INTENT_SERVICE_UNAVAILABLE",
      "Transaction intent storage is temporarily unavailable. Please retry.",
      { cause },
    );
  }

  /** 500 — unexpected failure; the raw cause is logged, never returned. */
  public static internal(cause: unknown): ApiError {
    return new ApiError(
      500,
      "INTERNAL_SERVER_ERROR",
      "An unexpected error occurred.",
      { cause },
    );
  }
}
