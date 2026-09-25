import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { mapGoogleAuthError, refreshAccessToken } from "../routes/googleSheets";

// ---------------------------------------------------------------------------
// mapGoogleAuthError — typed error classifier
// ---------------------------------------------------------------------------

describe("mapGoogleAuthError", () => {
  // ── REAUTH_REQUIRED ───────────────────────────────────────────────────────
  it("maps invalid_grant to REAUTH_REQUIRED", () => {
    const mapped = mapGoogleAuthError(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    });
    expect(mapped.code).toBe("REAUTH_REQUIRED");
    expect(mapped.status).toBe(401);
    expect(mapped.message).toMatch(/revoked/i);
  });

  it("maps description containing 'revoked' to REAUTH_REQUIRED", () => {
    const mapped = mapGoogleAuthError(400, {
      error: "invalid_grant",
      error_description: "The token has been revoked by the user.",
    });
    expect(mapped.code).toBe("REAUTH_REQUIRED");
  });

  it("maps description containing 'expired' to REAUTH_REQUIRED", () => {
    const mapped = mapGoogleAuthError(400, {
      error: "invalid_grant",
      error_description: "Token has been expired.",
    });
    expect(mapped.code).toBe("REAUTH_REQUIRED");
  });

  // ── OAUTH_DENIED ──────────────────────────────────────────────────────────
  it("maps access_denied error to OAUTH_DENIED", () => {
    const mapped = mapGoogleAuthError(401, {
      error: "access_denied",
      error_description: "The user denied access.",
    });
    expect(mapped.code).toBe("OAUTH_DENIED");
    expect(mapped.status).toBe(401);
    expect(mapped.message).toMatch(/denied/i);
  });

  it("maps access_denied in error_description to OAUTH_DENIED", () => {
    const mapped = mapGoogleAuthError(401, {
      error: "oauth_error",
      error_description: "access_denied by user",
    });
    expect(mapped.code).toBe("OAUTH_DENIED");
  });

  // ── INSUFFICIENT_SCOPE ────────────────────────────────────────────────────
  it("maps insufficient_scope error to INSUFFICIENT_SCOPE", () => {
    const mapped = mapGoogleAuthError(403, {
      error: "insufficient_scope",
      error_description: "Request had insufficient authentication scopes.",
    });
    expect(mapped.code).toBe("INSUFFICIENT_SCOPE");
    expect(mapped.status).toBe(403);
    expect(mapped.message).toMatch(/Sheets permission/i);
  });

  it("maps 403 with 'scope' in description to INSUFFICIENT_SCOPE", () => {
    const mapped = mapGoogleAuthError(403, {
      error: "forbidden",
      error_description: "Missing required scope for this operation.",
    });
    expect(mapped.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("maps 403 with 'insufficient' in description to INSUFFICIENT_SCOPE", () => {
    const mapped = mapGoogleAuthError(403, {
      error: "forbidden",
      error_description: "Insufficient permissions for spreadsheets.",
    });
    expect(mapped.code).toBe("INSUFFICIENT_SCOPE");
  });

  // ── TOKEN_EXPIRED ─────────────────────────────────────────────────────────
  it("maps bare 401 (no invalid_grant) to TOKEN_EXPIRED", () => {
    const mapped = mapGoogleAuthError(401, { error: "invalid_token" });
    expect(mapped.code).toBe("TOKEN_EXPIRED");
    expect(mapped.status).toBe(401);
    expect(mapped.message).toMatch(/expired/i);
  });

  // ── ACCESS_DENIED ─────────────────────────────────────────────────────────
  it("maps 403 without scope keywords to ACCESS_DENIED", () => {
    const mapped = mapGoogleAuthError(403, {
      error: "forbidden",
      error_description: "User does not have access to this spreadsheet.",
    });
    expect(mapped.code).toBe("ACCESS_DENIED");
  });

  it("maps 404 to ACCESS_DENIED with the original description", () => {
    const mapped = mapGoogleAuthError(404, {
      error: "notFound",
      error_description: "Requested entity was not found.",
    });
    expect(mapped.code).toBe("ACCESS_DENIED");
    expect(mapped.status).toBe(404);
  });

  it("maps unknown errors to ACCESS_DENIED", () => {
    const mapped = mapGoogleAuthError(500, {});
    expect(mapped.code).toBe("ACCESS_DENIED");
  });

  it("returns at least status 400 when input status is < 400", () => {
    const mapped = mapGoogleAuthError(200, { error: "something_weird" });
    expect(mapped.status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken — network and API error handling
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "test-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("throws REAUTH_REQUIRED when Google returns invalid_grant", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: "invalid_grant",
        error_description: "Token has been revoked.",
      }),
    }) as typeof fetch;

    await expect(refreshAccessToken("revoked-token")).rejects.toMatchObject({
      code: "REAUTH_REQUIRED",
    });
  });

  it("throws TOKEN_EXPIRED when Google returns 401 without invalid_grant", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_token" }),
    }) as typeof fetch;

    await expect(refreshAccessToken("expired-token")).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
  });

  it("throws INSUFFICIENT_SCOPE when Google returns 403 with scope error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: "insufficient_scope",
        error_description: "Request had insufficient scopes.",
      }),
    }) as typeof fetch;

    await expect(refreshAccessToken("token")).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
    });
  });

  it("throws NETWORK_ERROR when fetch() itself rejects (offline)", async () => {
    global.fetch = jest.fn().mockRejectedValue(
      new TypeError("Failed to fetch"),
    ) as typeof fetch;

    await expect(refreshAccessToken("any-token")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("throws NETWORK_ERROR with status 503 for network failures", async () => {
    global.fetch = jest.fn().mockRejectedValue(
      new Error("ECONNREFUSED"),
    ) as typeof fetch;

    const err = await refreshAccessToken("any-token").catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.status).toBe(503);
  });

  it("succeeds and returns token data on happy path", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/spreadsheets",
      }),
    }) as typeof fetch;

    const result = await refreshAccessToken("valid-refresh");
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("valid-refresh"); // preserved
    expect(result.expiresIn).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// GET /rows — missing endpoint (now implemented)
// ---------------------------------------------------------------------------

describe("GET /google-sheets/rows route", () => {
  let app: import("express").Express;

  beforeEach(async () => {
    jest.resetModules();
    const { createApp } = await import("../app");
    app = createApp();
  });

  it("returns 400 when spreadsheetId is missing", async () => {
    const request = await import("supertest");
    const res = await request
      .default(app)
      .get("/api/google-sheets/rows?sheetName=Metrics")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(400);
    expect(res.body.code).toBeDefined();
  });

  it("returns 400 when Authorization header is missing", async () => {
    const request = await import("supertest");
    const res = await request
      .default(app)
      .get("/api/google-sheets/rows?spreadsheetId=abc&sheetName=Metrics");

    expect(res.status).toBe(400);
  });

  it("returns 503 with NETWORK_ERROR code when Google is unreachable", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch")) as typeof fetch;

    const request = await import("supertest");
    const res = await request
      .default(app)
      .get("/api/google-sheets/rows?spreadsheetId=abc&sheetName=Metrics")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("NETWORK_ERROR");

    global.fetch = jest.fn() as typeof fetch;
  });

  it("returns 401 with TOKEN_EXPIRED code when Google returns 401", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_token" }),
    }) as typeof fetch;

    const request = await import("supertest");
    const res = await request
      .default(app)
      .get("/api/google-sheets/rows?spreadsheetId=abc&sheetName=Metrics")
      .set("Authorization", "Bearer expired-token");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_EXPIRED");

    global.fetch = jest.fn() as typeof fetch;
  });

  it("returns 403 with INSUFFICIENT_SCOPE when Google returns 403 with scope error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: "insufficient_scope",
        error_description: "Insufficient scope for spreadsheets.",
      }),
    }) as typeof fetch;

    const request = await import("supertest");
    const res = await request
      .default(app)
      .get("/api/google-sheets/rows?spreadsheetId=abc&sheetName=Metrics")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_SCOPE");

    global.fetch = jest.fn() as typeof fetch;
  });
});
