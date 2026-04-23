/**
 * Google Sheets Integration Service
 * Handles OAuth and spreadsheet sync
 */

import type { GoogleSheetsConfig, GoogleOAuthSession, DailyYieldMetric } from "./types";

const STORAGE_KEY = "stellar_yield_google_sheets";
const SESSION_KEY = "stellar_yield_google_oauth";

export class GoogleSheetsService {
    private clientId: string;
    private clientSecret: string;
    private redirectUri: string;

    constructor(clientId: string, clientSecret: string, redirectUri: string) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.redirectUri = redirectUri;
    }

    /**
     * Get OAuth authorization URL
     */
    getAuthorizationUrl(): string {
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            response_type: "code",
            scope: "https://www.googleapis.com/auth/spreadsheets",
            access_type: "offline",
            prompt: "consent",
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeCodeForTokens(code: string): Promise<GoogleOAuthSession> {
        const response = await fetch("/api/google-sheets/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, redirectUri: this.redirectUri }),
        });

        if (!response.ok) {
            throw new Error(`Token exchange failed: ${response.statusText}`);
        }

        const data = (await response.json()) as {
            accessToken: string;
            refreshToken: string;
            expiresIn: number;
            email: string;
        };

        const session: GoogleOAuthSession = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            expiresAt: Date.now() + data.expiresIn * 1000,
            email: data.email,
        };

        this.saveSession(session);
        return session;
    }

    /**
     * Link Google account to spreadsheet
     */
    async linkSpreadsheet(spreadsheetId: string, sheetName: string): Promise<GoogleSheetsConfig> {
        const session = this.getSession();
        if (!session) {
            throw new Error("Not authenticated with Google");
        }

        // Verify spreadsheet access
        const response = await fetch(`/api/google-sheets/verify`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.accessToken}`,
            },
            body: JSON.stringify({ spreadsheetId, sheetName }),
        });

        if (!response.ok) {
            throw new Error("Cannot access spreadsheet");
        }

        const config: GoogleSheetsConfig = {
            spreadsheetId,
            sheetName,
            isLinked: true,
            linkedAt: Date.now(),
        };

        this.saveConfig(config);
        return config;
    }

    /**
     * Append daily yield metrics to spreadsheet
     */
    async appendYieldMetrics(metrics: DailyYieldMetric[]): Promise<void> {
        const session = this.getSession();
        const config = this.getConfig();

        if (!session || !config) {
            throw new Error("Google Sheets not configured");
        }

        const rows = metrics.map((m) => [
            m.date,
            m.vaultName,
            m.depositAmount.toString(),
            m.currentValue.toString(),
            m.dailyYield.toString(),
            m.apy.toFixed(2),
        ]);

        const response = await fetch("/api/google-sheets/append", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.accessToken}`,
            },
            body: JSON.stringify({
                spreadsheetId: config.spreadsheetId,
                sheetName: config.sheetName,
                rows,
            }),
        });

        if (!response.ok) {
            throw new Error("Failed to append metrics");
        }
    }

    /**
     * Unlink Google account
     */
    unlinkAccount(): void {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SESSION_KEY);
    }

    /**
     * Get current configuration
     */
    getConfig(): GoogleSheetsConfig | null {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? (JSON.parse(stored) as GoogleSheetsConfig) : null;
        } catch {
            return null;
        }
    }

    /**
     * Get current session
     */
    getSession(): GoogleOAuthSession | null {
        try {
            const stored = localStorage.getItem(SESSION_KEY);
            if (!stored) return null;

            const session = JSON.parse(stored) as GoogleOAuthSession;

            // Check if token expired
            if (session.expiresAt < Date.now()) {
                return null; // Token expired, need refresh
            }

            return session;
        } catch {
            return null;
        }
    }

    private saveConfig(config: GoogleSheetsConfig): void {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    }

    private saveSession(session: GoogleOAuthSession): void {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }
}
