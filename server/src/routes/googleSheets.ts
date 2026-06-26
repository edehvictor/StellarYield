/**
 * Google Sheets Integration API
 * OAuth token exchange, refresh, and spreadsheet operations.
 */

import { Router, type Request, type Response } from "express";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type GoogleAuthErrorCode =
  | "REAUTH_REQUIRED"
  | "INSUFFICIENT_SCOPE"
  | "TOKEN_EXPIRED"
  | "ACCESS_DENIED";

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

export function mapGoogleAuthError(
  status: number,
  body: unknown,
): { status: number; code: GoogleAuthErrorCode; message: string } {
  const parsed = parseGoogleError(body);
  const description = parsed.error_description ?? "";
  const error = parsed.error ?? "";

  if (error === "invalid_grant" || description.toLowerCase().includes("revoked")) {
    return {
      status: 401,
      code: "REAUTH_REQUIRED",
      message: "Google authorization expired or was revoked. Please reconnect your account.",
    };
  }

  if (
    status === 403 &&
    (description.toLowerCase().includes("insufficient") ||
      description.toLowerCase().includes("scope") ||
      error === "insufficient_scope")
  ) {
    return {
      status: 403,
      code: "INSUFFICIENT_SCOPE",
      message:
        "Your Google account is missing the required Sheets permission. Reconnect to grant spreadsheet access.",
    };
  }

  if (status === 401) {
    return {
      status: 401,
      code: "TOKEN_EXPIRED",
      message: "Access token expired. Refresh or reconnect your Google account.",
    };
  }

  return {
    status: status >= 400 ? status : 400,
    code: "ACCESS_DENIED",
    message: description || error || "Google API request failed",
  };
}

async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
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

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    const mapped = mapGoogleAuthError(response.status, data);
    const err = new Error(mapped.message) as Error & { code: GoogleAuthErrorCode; status: number };
    err.code = mapped.code;
    err.status = mapped.status;
    throw err;
  }

  let email = "unknown";
  if (data.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(data.id_token.split(".")[1], "base64").toString());
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

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    const mapped = mapGoogleAuthError(response.status, data);
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
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 500, body: {} };
  }
}

async function appendToSpreadsheet(
  spreadsheetId: string,
  sheetName: string,
  rows: string[][],
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const range = `${sheetName}!A:F`;
  const response = await fetch(
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
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function hasRequiredScope(scopeHeader?: string): boolean {
  if (!scopeHeader) return true;
  return scopeHeader.split(" ").some((s) => s === SHEETS_SCOPE || s.endsWith("/auth/spreadsheets"));
}

const router = Router();

router.post("/token", async (req: Request, res: Response) => {
  try {
    const { code, redirectUri } = req.body as { code?: string; redirectUri?: string };
    if (!code || !redirectUri) {
      res.status(400).json({ error: "Missing code or redirectUri" });
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

router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: string };
    if (!refreshToken) {
      res.status(400).json({ error: "Missing refreshToken" });
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

router.post("/verify", async (req: Request, res: Response) => {
  try {
    const { spreadsheetId, sheetName } = req.body as {
      spreadsheetId?: string;
      sheetName?: string;
    };
    const accessToken = req.headers.authorization?.replace("Bearer ", "");

    if (!spreadsheetId || !sheetName || !accessToken) {
      res.status(400).json({ error: "Missing required parameters" });
      return;
    }

    const result = await verifySpreadsheetAccess(spreadsheetId, accessToken);
    if (!result.ok) {
      const mapped = mapGoogleAuthError(result.status, result.body);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Verification failed",
    });
  }
});

router.post("/append", async (req: Request, res: Response) => {
  try {
    const { spreadsheetId, sheetName, rows } = req.body as {
      spreadsheetId?: string;
      sheetName?: string;
      rows?: string[][];
    };
    const accessToken = req.headers.authorization?.replace("Bearer ", "");

    if (!spreadsheetId || !sheetName || !rows || !accessToken) {
      res.status(400).json({ error: "Missing required parameters" });
      return;
    }

    const result = await appendToSpreadsheet(spreadsheetId, sheetName, rows, accessToken);
    if (!result.ok) {
      const mapped = mapGoogleAuthError(result.status, result.body);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      return;
    }

    res.json({ success: true, rowsAppended: rows.length });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Append failed",
    });
  }
});

export { SHEETS_SCOPE, hasRequiredScope };
export default router;
