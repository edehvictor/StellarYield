/**
 * Google Sheets Integration API Endpoints
 * Handles OAuth token exchange and spreadsheet operations
 */

import { Router, type Request, type Response } from "express";
import { logger } from "../utils/logger";

interface TokenExchangeRequest {
    code: string;
    redirectUri: string;
}

interface TokenResponse {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    email: string;
}

interface VerifyRequest {
    spreadsheetId: string;
    sheetName: string;
}

interface AppendRequest {
    spreadsheetId: string;
    sheetName: string;
    rows: string[][];
}

/**
 * Exchange authorization code for OAuth tokens
 * In production: securely store encrypted refresh tokens in database
 */
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

    if (!response.ok) {
        throw new Error("Token exchange failed");
    }

    const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        id_token?: string;
    };

    // Decode ID token to get email
    let email = "unknown";
    if (data.id_token) {
        try {
            const payload = JSON.parse(Buffer.from(data.id_token.split(".")[1], "base64").toString());
            email = payload.email || "unknown";
        } catch {
            // Ignore decode errors
        }
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || "",
        expiresIn: data.expires_in,
        email,
    };
}

/**
 * Verify access to spreadsheet
 */
async function verifySpreadsheetAccess(
    spreadsheetId: string,
    accessToken: string,
): Promise<boolean> {
    try {
        const response = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
            {
                headers: { Authorization: `Bearer ${accessToken}` },
            },
        );
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Append rows to spreadsheet
 */
async function appendToSpreadsheet(
    spreadsheetId: string,
    sheetName: string,
    rows: string[][],
    accessToken: string,
): Promise<void> {
    const range = `${sheetName}!A:F`;
    const values = rows;

    const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ values }),
        },
    );

    if (!response.ok) {
        throw new Error("Failed to append to spreadsheet");
    }
}

export function createGoogleSheetsRouter(): Router {
    const router = Router();

    /**
     * POST /api/google-sheets/token
     * Exchange authorization code for tokens
     */
    router.post("/google-sheets/token", async (req: Request, res: Response) => {
        try {
            const { code, redirectUri } = req.body as TokenExchangeRequest;

            if (!code || !redirectUri) {
                res.status(400).json({ error: "Missing code or redirectUri" });
                return;
            }

            const tokens = await exchangeCodeForTokens(code, redirectUri);

            // In production: encrypt and store refresh token in database
            logger.info({ email: tokens.email }, "Google OAuth token exchanged");

            res.json(tokens);
        } catch (error) {
            logger.error(error, "Token exchange failed");
            res.status(400).json({ error: error instanceof Error ? error.message : "Token exchange failed" });
        }
    });

    /**
     * POST /api/google-sheets/verify
     * Verify access to spreadsheet
     */
    router.post("/google-sheets/verify", async (req: Request, res: Response) => {
        try {
            const { spreadsheetId, sheetName } = req.body as VerifyRequest;
            const accessToken = req.headers.authorization?.replace("Bearer ", "");

            if (!spreadsheetId || !sheetName || !accessToken) {
                res.status(400).json({ error: "Missing required parameters" });
                return;
            }

            const hasAccess = await verifySpreadsheetAccess(spreadsheetId, accessToken);

            if (!hasAccess) {
                res.status(403).json({ error: "Cannot access spreadsheet" });
                return;
            }

            res.json({ success: true });
            logger.info({ spreadsheetId }, "Spreadsheet verified");
        } catch (error) {
            logger.error(error, "Verification failed");
            res.status(400).json({ error: error instanceof Error ? error.message : "Verification failed" });
        }
    });

    /**
     * POST /api/google-sheets/append
     * Append daily yield metrics to spreadsheet
     */
    router.post("/google-sheets/append", async (req: Request, res: Response) => {
        try {
            const { spreadsheetId, sheetName, rows } = req.body as AppendRequest;
            const accessToken = req.headers.authorization?.replace("Bearer ", "");

            if (!spreadsheetId || !sheetName || !rows || !accessToken) {
                res.status(400).json({ error: "Missing required parameters" });
                return;
            }

            await appendToSpreadsheet(spreadsheetId, sheetName, rows, accessToken);

            res.json({ success: true, rowsAppended: rows.length });
            logger.info({ spreadsheetId, rowCount: rows.length }, "Metrics appended to spreadsheet");
        } catch (error) {
            logger.error(error, "Append failed");
            res.status(400).json({ error: error instanceof Error ? error.message : "Append failed" });
        }
    });

    return router;
}
