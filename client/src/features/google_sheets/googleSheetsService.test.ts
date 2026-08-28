/**
 * Google Sheets Service — typed error mapping tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoogleSheetsService } from "./googleSheetsService";
import {
  GoogleAuthError,
  classifyGoogleError,
  parseOAuthCallbackError,
} from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService() {
  return new GoogleSheetsService("client-id", "http://localhost:3000/callback");
}

function setSession(overrides: Record<string, unknown> = {}) {
  const session = {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    email: "test@example.com",
    grantedScopes: ["https://www.googleapis.com/auth/spreadsheets"],
    ...overrides,
  };
  localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(session));
  return session;
}

function setConfig(overrides: Record<string, unknown> = {}) {
  const config = {
    spreadsheetId: "sheet-123",
    sheetName: "Yield Metrics",
    isLinked: true,
    linkedAt: Date.now(),
    ...overrides,
  };
  localStorage.setItem("stellar_yield_google_sheets", JSON.stringify(config));
  return config;
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

describe("GoogleSheetsService — authorization URL", () => {
  it("generates an authorization URL with the required scope", () => {
    const url = makeService().getAuthorizationUrl();
    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url).toContain("client_id=client-id");
    expect(url).toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fspreadsheets");
  });
});

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

describe("GoogleSheetsService — session helpers", () => {
  let service: GoogleSheetsService;

  beforeEach(() => {
    service = makeService();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns null for an unconfigured service", () => {
    expect(service.getConfig()).toBeNull();
    expect(service.getSession()).toBeNull();
  });

  it("detects expired tokens via getSession", () => {
    setSession({ expiresAt: Date.now() - 1000 });
    expect(service.getSession()).toBeNull();
    expect(service.getAuthStatus()).toBe("expired");
  });

  it("returns a valid session when token has not expired", () => {
    setSession();
    const session = service.getSession();
    expect(session).toBeDefined();
    expect(session?.email).toBe("test@example.com");
    expect(service.getAuthStatus()).toBe("connected");
  });

  it("detects missing_scope when granted scopes lack Sheets", () => {
    setSession({ grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    expect(service.getAuthStatus()).toBe("missing_scope");
  });

  it("unlinks the account and clears both config and session", () => {
    setSession();
    setConfig();
    service.unlinkAccount();
    expect(service.getConfig()).toBeNull();
    expect(service.getSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

describe("GoogleSheetsService — refreshAccessToken", () => {
  let service: GoogleSheetsService;

  beforeEach(() => {
    service = makeService();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("refreshes successfully and updates the stored session", async () => {
    setSession({ expiresAt: Date.now() - 1000 });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accessToken: "new-token", refreshToken: "refresh", expiresIn: 3600 }),
    });

    const session = await service.ensureValidSession();
    expect(session.accessToken).toBe("new-token");
    expect(service.getSession()?.accessToken).toBe("new-token");
  });

  it("throws REAUTH_REQUIRED and clears session on invalid_grant", async () => {
    setSession({ expiresAt: Date.now() - 1000 });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "Google authorization revoked.", code: "REAUTH_REQUIRED" }),
    });

    await expect(service.refreshAccessToken()).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(service.getRawSession()).toBeNull();
  });

  it("throws TOKEN_EXPIRED (not REAUTH_REQUIRED) on bare 401 without body code", async () => {
    setSession({ expiresAt: Date.now() - 1000 });

    // Server returns 401 with no explicit code — should distinguish TOKEN_EXPIRED
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_token" }),
    });

    const err = await service.refreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.code).toBe("TOKEN_EXPIRED");
  });

  it("throws NETWORK_ERROR when fetch() rejects (TypeError — offline)", async () => {
    setSession({ expiresAt: Date.now() - 1000 });

    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const err = await service.refreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.code).toBe("NETWORK_ERROR");
  });

  it("throws REAUTH_REQUIRED when no refresh token is stored", async () => {
    setSession({ refreshToken: "" });
    await expect(service.refreshAccessToken()).rejects.toMatchObject({
      code: "REAUTH_REQUIRED",
    });
  });
});

// ---------------------------------------------------------------------------
// linkSpreadsheet — typed errors from /verify
// ---------------------------------------------------------------------------

describe("GoogleSheetsService — linkSpreadsheet", () => {
  let service: GoogleSheetsService;

  beforeEach(() => {
    service = makeService();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("links successfully and persists config", async () => {
    setSession();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const config = await service.linkSpreadsheet("sheet-id", "Yield Metrics");
    expect(config.isLinked).toBe(true);
    expect(service.getConfig()?.spreadsheetId).toBe("sheet-id");
  });

  it("throws INSUFFICIENT_SCOPE from verify endpoint", async () => {
    setSession();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: "Missing Sheets permission.",
        code: "INSUFFICIENT_SCOPE",
      }),
    });

    await expect(service.linkSpreadsheet("sheet-id", "Metrics")).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
    });
  });

  it("throws ACCESS_DENIED when spreadsheet is not shared with connected account", async () => {
    setSession();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "no permission", code: "ACCESS_DENIED" }),
    });

    await expect(service.linkSpreadsheet("sheet-id", "Metrics")).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  });

  it("throws NETWORK_ERROR when fetch rejects during verify", async () => {
    setSession();
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const err = await service.linkSpreadsheet("sheet-id", "Metrics").catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
  });
});

// ---------------------------------------------------------------------------
// previewSync — typed errors from /rows
// ---------------------------------------------------------------------------

describe("GoogleSheetsService — previewSync", () => {
  let service: GoogleSheetsService;

  beforeEach(() => {
    service = makeService();
    localStorage.clear();
    vi.restoreAllMocks();
    setSession();
    setConfig();
  });

  it("throws when no spreadsheet is linked", async () => {
    localStorage.removeItem("stellar_yield_google_sheets");
    await expect(service.previewSync([])).rejects.toThrow("Google Sheets not configured");
  });

  it("fetches existing rows and returns a dry-run summary", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          {
            walletAddress: "GALICE",
            vaultName: "USDC Vault",
            asset: "USDC",
            timestamp: "2026-05-04",
            depositAmount: "1000",
            currentValue: "1050",
            dailyYield: "5",
            apy: "12.34",
          },
        ],
      }),
    });

    const summary = await service.previewSync([
      {
        date: "2026-05-04",
        vaultName: "USDC Vault",
        depositAmount: 1000n,
        currentValue: 1050n,
        dailyYield: 5n,
        apy: 12.34,
        walletAddress: "GALICE",
        asset: "USDC",
      },
      {
        date: "2026-05-05",
        vaultName: "USDC Vault",
        depositAmount: 1000n,
        currentValue: 1075n,
        dailyYield: 25n,
        apy: 12.4,
        walletAddress: "GALICE",
        asset: "USDC",
      },
    ]);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/google-sheets/rows?"),
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
    expect(summary.skipped).toHaveLength(1);
    expect(summary.added).toHaveLength(1);
    expect(summary.totalRows).toBe(2);
  });

  it("throws ACCESS_DENIED when reading rows returns 403", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "no access", code: "ACCESS_DENIED" }),
    });

    await expect(service.previewSync([])).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("throws TOKEN_EXPIRED when reading rows returns bare 401", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_token" }),
    });

    const err = await service.previewSync([]).catch((e) => e);
    expect(err.code).toBe("TOKEN_EXPIRED");
  });

  it("throws NETWORK_ERROR when fetch rejects during row fetch", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const err = await service.previewSync([]).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.code).toBe("NETWORK_ERROR");
  });
});

// ---------------------------------------------------------------------------
// handleOAuthCallback — OAuth denial and code exchange
// ---------------------------------------------------------------------------

describe("GoogleSheetsService — handleOAuthCallback", () => {
  let service: GoogleSheetsService;

  beforeEach(() => {
    service = makeService();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("throws OAUTH_DENIED when Google redirects with error=access_denied", async () => {
    const params = new URLSearchParams("error=access_denied");
    await expect(service.handleOAuthCallback(params)).rejects.toMatchObject({
      code: "OAUTH_DENIED",
    });
  });

  it("throws OAUTH_DENIED when there is no code in the callback", async () => {
    const params = new URLSearchParams("state=abc");
    await expect(service.handleOAuthCallback(params)).rejects.toMatchObject({
      code: "OAUTH_DENIED",
    });
  });

  it("throws INSUFFICIENT_SCOPE when Google redirects with error=invalid_scope", async () => {
    const params = new URLSearchParams("error=invalid_scope");
    await expect(service.handleOAuthCallback(params)).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
    });
  });

  it("exchanges code and returns a session on success", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: 3600,
        email: "user@example.com",
        scope: "https://www.googleapis.com/auth/spreadsheets",
      }),
    });

    const params = new URLSearchParams("code=auth-code-123");
    const session = await service.handleOAuthCallback(params);
    expect(session.accessToken).toBe("at");
    expect(session.email).toBe("user@example.com");
  });

  it("surfaces NETWORK_ERROR when token exchange fetch rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const params = new URLSearchParams("code=any-code");
    const err = await service.handleOAuthCallback(params).catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
  });
});

// ---------------------------------------------------------------------------
// classifyGoogleError — standalone error classifier
// ---------------------------------------------------------------------------

describe("classifyGoogleError", () => {
  it("passes through an existing GoogleAuthError unchanged", () => {
    const original = new GoogleAuthError("test", "ACCESS_DENIED");
    expect(classifyGoogleError(original)).toBe(original);
  });

  it("classifies TypeError as NETWORK_ERROR", () => {
    const err = classifyGoogleError(new TypeError("Failed to fetch"));
    expect(err.code).toBe("NETWORK_ERROR");
  });

  it("classifies Error with 'Failed to fetch' as NETWORK_ERROR", () => {
    const err = classifyGoogleError(new Error("Failed to fetch"));
    expect(err.code).toBe("NETWORK_ERROR");
  });

  it("classifies Error with 'ECONNREFUSED' as NETWORK_ERROR", () => {
    const err = classifyGoogleError(new Error("ECONNREFUSED"));
    expect(err.code).toBe("NETWORK_ERROR");
  });

  it("classifies Error with 'access_denied' as OAUTH_DENIED", () => {
    const err = classifyGoogleError(new Error("OAuth error: access_denied"));
    expect(err.code).toBe("OAUTH_DENIED");
  });

  it("classifies Error with 'revoked' as REAUTH_REQUIRED", () => {
    const err = classifyGoogleError(new Error("Token has been revoked"));
    expect(err.code).toBe("REAUTH_REQUIRED");
  });

  it("classifies Error with 'expired' as TOKEN_EXPIRED", () => {
    const err = classifyGoogleError(new Error("Token expired"));
    expect(err.code).toBe("TOKEN_EXPIRED");
  });

  it("classifies Error with 'scope' as INSUFFICIENT_SCOPE", () => {
    const err = classifyGoogleError(new Error("Missing required scope"));
    expect(err.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("classifies unrecognised Error as ACCESS_DENIED preserving message", () => {
    const err = classifyGoogleError(new Error("Something else went wrong"));
    expect(err.code).toBe("ACCESS_DENIED");
    expect(err.message).toBe("Something else went wrong");
  });

  it("classifies a plain string as ACCESS_DENIED", () => {
    const err = classifyGoogleError("something broke");
    expect(err.code).toBe("ACCESS_DENIED");
    expect(err.message).toBe("something broke");
  });

  it("classifies null/undefined as ACCESS_DENIED with fallback message", () => {
    expect(classifyGoogleError(null).code).toBe("ACCESS_DENIED");
    expect(classifyGoogleError(undefined).code).toBe("ACCESS_DENIED");
  });
});

// ---------------------------------------------------------------------------
// parseOAuthCallbackError — redirect parameter parsing
// ---------------------------------------------------------------------------

describe("parseOAuthCallbackError", () => {
  it("returns null when there is no error parameter", () => {
    expect(parseOAuthCallbackError(new URLSearchParams("code=abc"))).toBeNull();
  });

  it("returns OAUTH_DENIED for error=access_denied", () => {
    const err = parseOAuthCallbackError(new URLSearchParams("error=access_denied"));
    expect(err?.code).toBe("OAUTH_DENIED");
  });

  it("returns INSUFFICIENT_SCOPE for error=invalid_scope", () => {
    const err = parseOAuthCallbackError(new URLSearchParams("error=invalid_scope"));
    expect(err?.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("returns ACCESS_DENIED for an unknown error parameter", () => {
    const err = parseOAuthCallbackError(new URLSearchParams("error=server_error"));
    expect(err?.code).toBe("ACCESS_DENIED");
    expect(err?.message).toContain("server_error");
  });
});
