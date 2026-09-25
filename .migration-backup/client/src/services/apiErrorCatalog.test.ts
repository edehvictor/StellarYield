import { describe, it, expect } from "vitest";
import {
  CLIENT_ERROR_CATALOG,
  resolveApiError,
  isAutoRetryable,
  requiresReauth,
  parseApiErrorResponse,
} from "./apiErrorCatalog";

// ── Catalog completeness ───────────────────────────────────────────────────

describe("CLIENT_ERROR_CATALOG", () => {
  it("every entry has a non-empty userMessage and a code matching its key", () => {
    for (const [key, entry] of Object.entries(CLIENT_ERROR_CATALOG)) {
      expect(entry.code).toBe(key);
      expect(entry.userMessage.length).toBeGreaterThan(0);
    }
  });

  it("auth entries have recoveryAction=sign_in", () => {
    const authCodes = ["UNAUTHORIZED", "TOKEN_EXPIRED", "TOKEN_INVALID"];
    for (const code of authCodes) {
      expect(CLIENT_ERROR_CATALOG[code].recoveryAction).toBe("sign_in");
    }
  });

  it("blocking entries have recoveryLabel=null or a non-empty string", () => {
    for (const entry of Object.values(CLIENT_ERROR_CATALOG)) {
      if (entry.retryCategory === "blocking") {
        // recoveryLabel may be null (no action) or a string label
        expect(
          entry.recoveryLabel === null || typeof entry.recoveryLabel === "string",
        ).toBe(true);
      }
    }
  });
});

// ── resolveApiError ────────────────────────────────────────────────────────

describe("resolveApiError", () => {
  it("returns the matching entry for a known code", () => {
    const entry = resolveApiError("RATE_LIMITED");
    expect(entry.code).toBe("RATE_LIMITED");
    expect(entry.recoveryAction).toBe("retry");
    expect(entry.recoveryLabel).toBe("Try again");
  });

  it("returns a safe fallback for an unknown code", () => {
    const entry = resolveApiError("COMPLETELY_UNKNOWN");
    expect(entry.code).toBe("COMPLETELY_UNKNOWN");
    expect(entry.userMessage.length).toBeGreaterThan(0);
    expect(entry.recoveryAction).toBe("retry");
  });
});

// ── isAutoRetryable ────────────────────────────────────────────────────────

describe("isAutoRetryable", () => {
  it("returns true only for retry category", () => {
    expect(isAutoRetryable(resolveApiError("RATE_LIMITED"))).toBe(true);
    expect(isAutoRetryable(resolveApiError("INTERNAL_ERROR"))).toBe(true);
  });

  it("returns false for auth, blocking, reconnect, refresh", () => {
    expect(isAutoRetryable(resolveApiError("UNAUTHORIZED"))).toBe(false);
    expect(isAutoRetryable(resolveApiError("FORBIDDEN"))).toBe(false);
    expect(isAutoRetryable(resolveApiError("SERVICE_UNAVAILABLE"))).toBe(false);
    expect(isAutoRetryable(resolveApiError("CONFLICT"))).toBe(false);
  });
});

// ── requiresReauth ─────────────────────────────────────────────────────────

describe("requiresReauth", () => {
  it("returns true for auth category codes", () => {
    expect(requiresReauth(resolveApiError("TOKEN_EXPIRED"))).toBe(true);
    expect(requiresReauth(resolveApiError("UNAUTHORIZED"))).toBe(true);
  });

  it("returns false for non-auth codes", () => {
    expect(requiresReauth(resolveApiError("INTERNAL_ERROR"))).toBe(false);
    expect(requiresReauth(resolveApiError("VALIDATION_FAILED"))).toBe(false);
  });
});

// ── parseApiErrorResponse ──────────────────────────────────────────────────

describe("parseApiErrorResponse", () => {
  it("resolves from { code } field (new catalog shape)", () => {
    const entry = parseApiErrorResponse({ code: "TIMESTAMP_EXPIRED", message: "…" });
    expect(entry.code).toBe("TIMESTAMP_EXPIRED");
    expect(entry.recoveryAction).toBe("retry");
  });

  it("resolves from { error } field (legacy shape)", () => {
    const entry = parseApiErrorResponse({ error: "RATE_LIMITED" });
    expect(entry.code).toBe("RATE_LIMITED");
  });

  it("returns fallback for null body", () => {
    const entry = parseApiErrorResponse(null);
    expect(entry.recoveryAction).toBe("retry");
  });

  it("returns fallback for a string body", () => {
    const entry = parseApiErrorResponse("oops");
    expect(entry.recoveryAction).toBe("retry");
  });

  it("prefers { code } over { error } when both are present", () => {
    const entry = parseApiErrorResponse({ code: "VALIDATION_FAILED", error: "RATE_LIMITED" });
    expect(entry.code).toBe("VALIDATION_FAILED");
  });
});
