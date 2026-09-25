/**
 * Google Sheets Integration API
 * OAuth token exchange, refresh, spreadsheet operations, and typed error mapping.
 *
 * All routes are mounted under the "/google-sheets" prefix, so the full paths
 * are /api/google-sheets/token, /api/google-sheets/refresh, etc.
 * (app.ts registers this router as: app.use("/api/google-sheets", googleSheetsRouter))
 */

import { Router, type Request, type Response } from "express";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// ---------------------------------------------------------------------------
// Error codes (mirrored on the client in errors.ts)
// ---------------------------------------------------------------------------

/**
 * Stable machine-readable codes for every Google Sheets / OAuth failure mode.
 *
 * `OAUTH_DENIED`       — user cancelled or denied the OAuth consent screen.
 * `TOKEN_EXPIRED`      — access token expired; a silent refresh may succeed.
 * `REAUTH_REQUIRED`    — refresh token revoked/expired; must reconnect.
 * `INSUFFICIENT_SCOPE` — granted scopes missing Sheets permission.
 * `ACCESS_DENIED`      — spreadsheet permission or generic Google 403.
 * `NETWORK_ERROR`      — fetch() rejected (offline, DNS, timeout).
 */
export type GoogleAuthErrorCode =
  | "OAUTH_DENIED"
  | "TOKEN_EXPIRED"
  | "REAUTH_REQUIRED"
  | "INSUFFICIENT_SCOPE"
  | "ACCESS_DENIED"
  | "NETWORK_ERROR";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GoogleTokenError {
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  email: string;
  scope?: string;
}

function parseGoogleError(body: unknown): GoogleTokenError {
  if (body && typeof body === "object") {
    return body as GoogleTokenError;
  }
  return {};
}

// ---------------------------------------------------------------------------
// mapGoogleAuthError — canonical error classifier
// ---------------------------------------------------------------------------

/**
 * Translate a raw Google API HTTP status + response body into a typed error
 * descriptor that can be forwarded to the client verbatim.
 *
 * The returned `code` is one of the `GoogleAuthErrorCode` literals so the
 * client can branch on it without string-parsing.
 */
export function mapGoogleAuthError(
  status: number,
  body: unknown,
): { status: number; code: GoogleAuthErrorCode; message: string } {
  const parsed = parseGoogleError(body);
  const description = (parsed.error_description ?? "").toLowerCase();
  const error = parsed.error ?? "";

  // OAuth denial — user pressed "Deny" or the OAuth server rejected the flow
  if (error === "access_denied" || description.includes("access_denied")) {
    return {
      status: 401,
      code: "OAUTH_DENIED",
      message: "Google sign-in was cancelled or denied. Please try connecting again.",
    };
  }

  // Revoked / expired refresh token — user must re-authenticate
  if (error === "invalid_grant" || description.includes("revoked") || description.includes("expired")) {
    return {
      status: 401,
      code: "REAUTH_REQUIRED",
      message: "Google authorization expired or was revoked. Please reconnect your account.",
    };
  }

  // Missing Sheets scope
  if (
    status === 403 &&
    (description.includes("insufficient") ||
      description.includes("scope") ||
      error === "insufficient_scope")
  ) {
    return {
      status: 403,
      code: "INSUFFICIENT_SCOPE",
      message:
        "Your Google account is missing the required Sheets permission. Reconnect to grant spreadsheet access.",
    };
  }

  // Access token expired (but refresh token may still be valid)
  if (status === 401) {
    return {
      status: 401,
      code: "TOKEN_EXPIRED",
      message: "Access token expired. Refresh or reconnect your Google account.",
    };
  }

  // Generic access denial (wrong spreadsheet permissions, etc.)
  return {
    status: status >= 400 ? status : 400,
    code: "ACCESS_DENIED",
    message: parsed.error_description || error || "Google API request failed",
  };
}

/**
 * Wrap a Google API network call so that fetch() rejections (offline, DNS,
 * timeout) are caught and surfaced as a structured `NETWORK_ERROR` response
 * rather than an unhandled exception.
 */
async function safeFetch(
  ...args: Parameters<typeof fetch>
): Promise<{ ok: boolean; status: number; body: unknown; networkError?: string }> {
  try {
    const response = await fetch(...args);
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network request failed";
    return { ok: false, status: 0, body: {}, networkError: message };
  }
}

// ---------------------------------------------------------------------------
// Google OAuth helpers
// ---------------------------------------------------------------------------

async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials not configured");
  }

  const result = await safeFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (result.networkError) {
    const err = new Error("Could not reach Google — network error") as Error & {
      code: GoogleAuthErrorCode;
      status: number;
    };
    err.code = "NETWORK_ERROR";
    err.status = 503;
    throw err;
  }

  const data = result.body as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!result.ok) {
    const mapped = mapGoogleAuthError(result.status, data);
    const err = new Error(mapped.message) as Error & { code: GoogleAuthErrorCode; status: number };
    err.code = mapped.code;
    err.status = mapped.status;
    throw err;
  }

  let email = "unknown";
  if (data.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(data.id_token.split(".")[1], "base64").toString(),
      );
      email = payload.email || "unknown";
    } catch {
      // ignore decode errors
    }
  }

  return {
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? "",
    expiresIn: data.expires_in ?? 3600,
    email,
    scope: data.scope,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials not configured");
  }

  const result = await safeFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (result.networkError) {
    const err = new Error("Could not reach Google — network error") as Error & {
      code: GoogleAuthErrorCode;
      status: number;
    };
    err.code = "NETWORK_ERROR";
    err.status = 503;
    throw err;
  }

  const data = result.body as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!result.ok) {
    const mapped = mapGoogleAuthError(result.status, data);
    const err = new Error(mapped.message) as Error & { code: GoogleAuthErrorCode; status: number };
    err.code = mapped.code;
    err.status = mapped.status;
    throw err;
  }

  return {
    accessToken: data.access_token ?? "",
    refreshToken,
    expiresIn: data.expires_in ?? 3600,
    email: "unknown",
    scope: data.scope,
  };
}

async function verifySpreadsheetAccess(
  spreadsheetId: string,
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown; networkError?: string }> {
  return safeFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

async function appendToSpreadsheet(
  spreadsheetId: string,
  sheetName: string,
  rows: string[][],
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown; networkError?: string }> {
  const range = `${sheetName}!A:F`;
  return safeFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ values: rows }),
    },
  );
}

/**
 * Fetch the rows currently present in a spreadsheet sheet so the client can
 * run a dry-run diff before committing a sync.
 *
 * Returns the raw cell values from the Sheets API formatted as
 * `{ rows: ExistingSheetRow[] }` where each row maps column positions to the
 * field names the client expects.
 */
async function fetchSpreadsheetRows(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown; networkError?: string }> {
  const range = `${sheetName}!A:H`;
  return safeFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

function hasRequiredScope(scopeHeader?: string): boolean {
  if (!scopeHeader) return true;
  return scopeHeader
    .split(" ")
    .some((s) => s === SHEETS_SCOPE || s.endsWith("/auth/spreadsheets"));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = Router();

/**
 * POST /google-sheets/token
 * Exchange an authorization code for access + refresh tokens.
 */
router.post("/token", async (req: Request, res: Response) => {
  try {
    const { code, redirectUri } = req.body as { code?: string; redirectUri?: string };
    if (!code || !redirectUri) {
      res.status(400).json({ error: "Missing code or redirectUri", code: "ACCESS_DENIED" });
      return;
    }

    const tokens = await exchangeCodeForTokens(code, redirectUri);
    res.json(tokens);
  } catch (error) {
    const err = error as Error & { code?: GoogleAuthErrorCode; status?: number };
    res.status(err.status ?? 400).json({
      error: err.message,
      code: err.code ?? "ACCESS_DENIED",
    });
  }
});

/**
 * POST /google-sheets/refresh
 * Exchange a refresh token for a new access token.
 */
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: string };
    if (!refreshToken) {
      res.status(400).json({ error: "Missing refreshToken", code: "ACCESS_DENIED" });
      return;
    }

    const tokens = await refreshAccessToken(refreshToken);
    res.json(tokens);
  } catch (error) {
    const err = error as Error & { code?: GoogleAuthErrorCode; status?: number };
    res.status(err.status ?? 400).json({
      error: err.message,
      code: err.code ?? "ACCESS_DENIED",
    });
  }
});

/**
 * POST /google-sheets/verify
 * Confirm the connected account can access the requested spreadsheet.
 */
router.post("/verify", async (req: Request, res: Response) => {
  try {
    const { spreadsheetId, sheetName } = req.body as {
      spreadsheetId?: string;
      sheetName?: string;
    };
    const accessToken = req.headers.authorization?.replace("Bearer ", "");

    if (!spreadsheetId || !sheetName || !accessToken) {
      res.status(400).json({ error: "Missing required parameters", code: "ACCESS_DENIED" });
      return;
    }

    const result = await verifySpreadsheetAccess(spreadsheetId, accessToken);

    if (result.networkError) {
      res.status(503).json({
        error: "Could not reach Google — check your internet connection.",
        code: "NETWORK_ERROR" as GoogleAuthErrorCode,
      });
      return;
    }

    if (!result.ok) {
      const mapped = mapGoogleAuthError(result.status, result.body);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Verification failed",
      code: "ACCESS_DENIED" as GoogleAuthErrorCode,
    });
  }
});

/**
 * POST /google-sheets/append
 * Append yield metric rows to a spreadsheet.
 */
router.post("/append", async (req: Request, res: Response) => {
  try {
    const { spreadsheetId, sheetName, rows } = req.body as {
      spreadsheetId?: string;
      sheetName?: string;
      rows?: string[][];
    };
    const accessToken = req.headers.authorization?.replace("Bearer ", "");

    if (!spreadsheetId || !sheetName || !rows || !accessToken) {
      res.status(400).json({ error: "Missing required parameters", code: "ACCESS_DENIED" });
      return;
    }

    const result = await appendToSpreadsheet(spreadsheetId, sheetName, rows, accessToken);

    if (result.networkError) {
      res.status(503).json({
        error: "Could not reach Google — check your internet connection.",
        code: "NETWORK_ERROR" as GoogleAuthErrorCode,
      });
      return;
    }

    if (!result.ok) {
      const mapped = mapGoogleAuthError(result.status, result.body);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      return;
    }

    res.json({ success: true, rowsAppended: rows.length });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Append failed",
      code: "ACCESS_DENIED" as GoogleAuthErrorCode,
    });
  }
});

/**
 * GET /google-sheets/rows
 * Read the current rows from a spreadsheet sheet for dry-run diffing.
 *
 * Query params: spreadsheetId, sheetName
 * Header:       Authorization: Bearer <accessToken>
 */
router.get("/rows", async (req: Request, res: Response) => {
  try {
    const { spreadsheetId, sheetName } = req.query as {
      spreadsheetId?: string;
      sheetName?: string;
    };
    const accessToken = req.headers.authorization?.replace("Bearer ", "");

    if (!spreadsheetId || !sheetName || !accessToken) {
      res.status(400).json({ error: "Missing required parameters", code: "ACCESS_DENIED" });
      return;
    }

    const result = await fetchSpreadsheetRows(spreadsheetId, sheetName, accessToken);

    if (result.networkError) {
      res.status(503).json({
        error: "Could not reach Google — check your internet connection.",
        code: "NETWORK_ERROR" as GoogleAuthErrorCode,
      });
      return;
    }

    if (!result.ok) {
      const mapped = mapGoogleAuthError(result.status, result.body);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      return;
    }

    // The Sheets API returns { values: string[][] }.
    // We map each row to the ExistingSheetRow shape the client expects.
    // Column order: walletAddress(0), vaultName(1), asset(2), timestamp(3),
    //               depositAmount(4), currentValue(5), dailyYield(6), apy(7)
    const data = result.body as { values?: string[][] };
    const rawRows = data.values ?? [];

    // Skip header row if present (first cell is "walletAddress" or similar heading)
    const dataRows = rawRows.filter(
      (r) => r.length > 0 && r[0]?.toLowerCase() !== "walletaddress",
    );

    const rows = dataRows.map((r) => ({
      walletAddress: r[0] ?? "",
      vaultName: r[1] ?? "",
      asset: r[2] ?? "",
      timestamp: r[3] ?? "",
      depositAmount: r[4] ?? "0",
      currentValue: r[5] ?? "0",
      dailyYield: r[6] ?? "0",
      apy: r[7] ?? "0",
    }));

    res.json({ rows });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to read rows",
      code: "ACCESS_DENIED" as GoogleAuthErrorCode,
    });
  }
});

export { SHEETS_SCOPE, hasRequiredScope };
export default router;
