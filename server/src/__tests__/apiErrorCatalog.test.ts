import {
  API_ERRORS,
  lookupError,
  isKnownApiError,
  isRetryable,
  type ApiErrorCode,
} from "../types/apiErrorCatalog";

describe("API_ERRORS catalog", () => {
  it("every entry has a non-empty code, message, and valid HTTP status", () => {
    for (const [key, descriptor] of Object.entries(API_ERRORS)) {
      expect(descriptor.code).toBe(key);
      expect(descriptor.defaultMessage.length).toBeGreaterThan(0);
      // HTTP status must be a valid 2xx (e.g. warning on success) or 4xx/5xx error code
      expect(descriptor.httpStatus).toBeGreaterThanOrEqual(200);
      expect(descriptor.httpStatus).toBeLessThan(600);
    }
  });

  it("auth codes use HTTP 401 or 403", () => {
    const authCodes: ApiErrorCode[] = [
      "UNAUTHORIZED",
      "TOKEN_EXPIRED",
      "TOKEN_INVALID",
    ];
    for (const code of authCodes) {
      expect([401, 403]).toContain(API_ERRORS[code].httpStatus);
    }
  });

  it("FORBIDDEN is blocking (cannot recover without operator action)", () => {
    expect(API_ERRORS.FORBIDDEN.retryCategory).toBe("blocking");
  });

  it("TIMESTAMP_EXPIRED is retryable — clock drift may resolve on retry", () => {
    expect(API_ERRORS.TIMESTAMP_EXPIRED.retryCategory).toBe("retry");
  });

  it("TIMESTAMP_MISSING and TIMESTAMP_INVALID are blocking — bad request structure", () => {
    expect(API_ERRORS.TIMESTAMP_MISSING.retryCategory).toBe("blocking");
    expect(API_ERRORS.TIMESTAMP_INVALID.retryCategory).toBe("blocking");
  });

  it("INTERNAL_ERROR and UPSTREAM_TIMEOUT are retryable", () => {
    expect(API_ERRORS.INTERNAL_ERROR.retryCategory).toBe("retry");
    expect(API_ERRORS.UPSTREAM_TIMEOUT.retryCategory).toBe("retry");
  });

  it("SERVICE_UNAVAILABLE and DB_UNAVAILABLE require reconnect", () => {
    expect(API_ERRORS.SERVICE_UNAVAILABLE.retryCategory).toBe("reconnect");
    expect(API_ERRORS.DB_UNAVAILABLE.retryCategory).toBe("reconnect");
  });
});

describe("lookupError", () => {
  it("returns the descriptor for a known code", () => {
    const d = lookupError("RATE_LIMITED");
    expect(d?.code).toBe("RATE_LIMITED");
    expect(d?.httpStatus).toBe(429);
  });

  it("returns undefined for an unknown code", () => {
    expect(lookupError("NOT_A_REAL_CODE")).toBeUndefined();
  });
});

describe("isKnownApiError", () => {
  it("returns true for catalog entries", () => {
    expect(isKnownApiError("VALIDATION_FAILED")).toBe(true);
    expect(isKnownApiError("NOT_FOUND")).toBe(true);
  });

  it("returns false for arbitrary strings", () => {
    expect(isKnownApiError("MADE_UP_CODE")).toBe(false);
    expect(isKnownApiError("")).toBe(false);
  });
});

describe("isRetryable", () => {
  it("returns true for retry and reconnect categories", () => {
    expect(isRetryable("retry")).toBe(true);
    expect(isRetryable("reconnect")).toBe(true);
  });

  it("returns false for blocking, auth, and refresh categories", () => {
    expect(isRetryable("blocking")).toBe(false);
    expect(isRetryable("auth")).toBe(false);
    expect(isRetryable("refresh")).toBe(false);
  });
});
