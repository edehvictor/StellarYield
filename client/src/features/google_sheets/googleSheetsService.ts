/**
 * Google Sheets Integration Service
 * Handles OAuth, token refresh, and spreadsheet sync
 */

import type { GoogleSheetsConfig, GoogleOAuthSession, DailyYieldMetric } from "./types";
import {
  GoogleAuthError,
  GOOGLE_AUTH_MESSAGES,
  REQUIRED_SHEETS_SCOPE,
  classifyGoogleError,
  parseOAuthCallbackError,
  type GoogleAuthErrorCode,
} from "./errors";
import {
  computeDryRunSyncPlan,
  type DryRunSyncSummary,
  type ExistingSheetRow,
} from "./dryRunSync";

const STORAGE_KEY = "stellar_yield_google_sheets";
const SESSION_KEY = "stellar_yield_google_oauth";
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface ApiErrorBody {
  error?: string;
  code?: GoogleAuthErrorCode;
}

export class GoogleSheetsService {
    private clientId: string;
    private redirectUri: string;

    constructor(clientId: string, redirectUri: string) {
        this.clientId = clientId;
        this.redirectUri = redirectUri;
    }

    getAuthorizationUrl(): string {
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            response_type: "code",
            scope: REQUIRED_SHEETS_SCOPE,
            access_type: "offline",
            prompt: "consent",
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }

    async exchangeCodeForTokens(code: string): Promise<GoogleOAuthSession> {
        let response: Response;
        try {
            response = await fetch("/api/google-sheets/token", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code, redirectUri: this.redirectUri }),
            });
        } catch (networkErr) {
            throw classifyGoogleError(networkErr);
        }

        if (!response.ok) {
            throw await this.parseApiError(response, "Token exchange failed");
        }

        const data = (await response.json()) as {
            accessToken: string;
            refreshToken: string;
            expiresIn: number;
            email: string;
            scope?: string;
        };

        const session: GoogleOAuthSession = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            expiresAt: Date.now() + data.expiresIn * 1000,
            email: data.email,
            grantedScopes: data.scope?.split(" ").filter(Boolean),
            authStatus: "active",
        };

        this.saveSession(session);
        return session;
    }

    async refreshAccessToken(): Promise<GoogleOAuthSession> {
        const raw = this.getRawSession();
        if (!raw?.refreshToken) {
            this.clearSession();
            throw new GoogleAuthError(GOOGLE_AUTH_MESSAGES.REAUTH_REQUIRED, "REAUTH_REQUIRED");
        }

        let response: Response;
        try {
            response = await fetch("/api/google-sheets/refresh", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refreshToken: raw.refreshToken }),
            });
        } catch (networkErr) {
            throw classifyGoogleError(networkErr);
        }

        if (!response.ok) {
            const err = await this.parseApiError(response, "Token refresh failed");
            if (err.code === "REAUTH_REQUIRED") {
                this.clearSession();
            }
            throw err;
        }

        const data = (await response.json()) as {
            accessToken: string;
            refreshToken: string;
            expiresIn: number;
            scope?: string;
        };

        const session: GoogleOAuthSession = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken || raw.refreshToken,
            expiresAt: Date.now() + data.expiresIn * 1000,
            email: raw.email,
            grantedScopes: data.scope?.split(" ").filter(Boolean) ?? raw.grantedScopes,
            authStatus: "active",
        };

        this.saveSession(session);
        return session;
    }

    async ensureValidSession(): Promise<GoogleOAuthSession> {
        const raw = this.getRawSession();
        if (!raw) {
            throw new GoogleAuthError(GOOGLE_AUTH_MESSAGES.REAUTH_REQUIRED, "REAUTH_REQUIRED");
        }

        if (!this.hasRequiredScopes(raw)) {
            throw new GoogleAuthError(GOOGLE_AUTH_MESSAGES.INSUFFICIENT_SCOPE, "INSUFFICIENT_SCOPE");
        }

        if (!this.isSessionExpired(raw)) {
            return raw;
        }

        return this.refreshAccessToken();
    }

    async linkSpreadsheet(spreadsheetId: string, sheetName: string): Promise<GoogleSheetsConfig> {
        const session = await this.ensureValidSession();

        let response: Response;
        try {
            response = await fetch(`/api/google-sheets/verify`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${session.accessToken}`,
                },
                body: JSON.stringify({ spreadsheetId, sheetName }),
            });
        } catch (networkErr) {
            throw classifyGoogleError(networkErr);
        }

        if (!response.ok) {
            throw await this.parseApiError(response, "Cannot access spreadsheet");
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
     * Preview what a sync of `metrics` would do to the linked spreadsheet
     * without writing anything: fetches the current sheet contents and
     * diffs them against `metrics` to classify each row as added, updated,
     * skipped, or conflicted (#962).
     */
    async previewSync(metrics: DailyYieldMetric[]): Promise<DryRunSyncSummary> {
        const session = await this.ensureValidSession();
        const config = this.getConfig();

        if (!config) {
            throw new Error("Google Sheets not configured");
        }

        const existingRows = await this.fetchExistingRows(session, config);
        return computeDryRunSyncPlan(metrics, existingRows);
    }

    private async fetchExistingRows(
        session: GoogleOAuthSession,
        config: GoogleSheetsConfig,
    ): Promise<ExistingSheetRow[]> {
        const params = new URLSearchParams({
            spreadsheetId: config.spreadsheetId,
            sheetName: config.sheetName,
        });

        let response: Response;
        try {
            response = await fetch(`/api/google-sheets/rows?${params}`, {
                headers: { Authorization: `Bearer ${session.accessToken}` },
            });
        } catch (networkErr) {
            throw classifyGoogleError(networkErr);
        }

        if (!response.ok) {
            throw await this.parseApiError(response, "Failed to read spreadsheet rows");
        }

        const data = (await response.json()) as { rows?: ExistingSheetRow[] };
        return data.rows ?? [];
    }

    async appendYieldMetrics(metrics: DailyYieldMetric[]): Promise<void> {
        const session = await this.ensureValidSession();
        const config = this.getConfig();

        if (!config) {
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

        let response: Response;
        try {
            response = await fetch("/api/google-sheets/append", {
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
        } catch (networkErr) {
            throw classifyGoogleError(networkErr);
        }

        if (!response.ok) {
            throw await this.parseApiError(response, "Failed to append metrics");
        }
    }

    unlinkAccount(): void {
        localStorage.removeItem(STORAGE_KEY);
        this.clearSession();
    }

    /**
     * Call this from the OAuth callback page after Google redirects back.
     *
     * If Google appended an `error` query parameter (e.g. `access_denied`
     * when the user cancelled), throws a typed `GoogleAuthError` so the UI
     * can display a contextual recovery message instead of a blank screen.
     *
     * On success, exchanges the `code` for tokens and returns the session.
     */
    async handleOAuthCallback(searchParams: URLSearchParams): Promise<GoogleOAuthSession> {
        const callbackError = parseOAuthCallbackError(searchParams);
        if (callbackError) throw callbackError;

        const code = searchParams.get("code");
        if (!code) {
            throw new GoogleAuthError(
                "No authorization code returned by Google.",
                "OAUTH_DENIED",
            );
        }

        return this.exchangeCodeForTokens(code);
    }

    getConfig(): GoogleSheetsConfig | null {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? (JSON.parse(stored) as GoogleSheetsConfig) : null;
        } catch {
            return null;
        }
    }

    getSession(): GoogleOAuthSession | null {
        const raw = this.getRawSession();
        if (!raw) return null;
        if (this.isSessionExpired(raw)) return null;
        return raw;
    }

    getRawSession(): GoogleOAuthSession | null {
        try {
            const stored = localStorage.getItem(SESSION_KEY);
            if (!stored) return null;
            return JSON.parse(stored) as GoogleOAuthSession;
        } catch {
            return null;
        }
    }

    getAuthStatus(): "connected" | "expired" | "missing_scope" | "not_connected" {
        const raw = this.getRawSession();
        if (!raw) return "not_connected";
        if (!this.hasRequiredScopes(raw)) return "missing_scope";
        if (this.isSessionExpired(raw)) {
            return raw.refreshToken ? "expired" : "not_connected";
        }
        return "connected";
    }

    hasRequiredScopes(session: GoogleOAuthSession): boolean {
        if (!session.grantedScopes || session.grantedScopes.length === 0) {
            return true;
        }
        return session.grantedScopes.some(
            (s) => s === REQUIRED_SHEETS_SCOPE || s.endsWith("/auth/spreadsheets"),
        );
    }

    isSessionExpired(session: GoogleOAuthSession): boolean {
        return session.expiresAt <= Date.now() + EXPIRY_SKEW_MS;
    }

    private async parseApiError(response: Response, fallback: string): Promise<GoogleAuthError> {
        let body: ApiErrorBody = {};
        try {
            body = (await response.json()) as ApiErrorBody;
        } catch {
            // ignore — use status-based fallback below
        }

        // Prefer an explicit code from the server response body.
        if (body.code) {
            const message =
                body.error ??
                GOOGLE_AUTH_MESSAGES[body.code] ??
                fallback;
            return new GoogleAuthError(message, body.code);
        }

        // Status-based fallback when the server didn't embed a code.
        if (response.status === 401) {
            // 401 without a body code means the access token itself is expired
            // (a refresh may still be possible), not that re-auth is required.
            return new GoogleAuthError(
                body.error ?? GOOGLE_AUTH_MESSAGES.TOKEN_EXPIRED,
                "TOKEN_EXPIRED",
            );
        }

        if (response.status === 403) {
            return new GoogleAuthError(
                body.error ?? GOOGLE_AUTH_MESSAGES.ACCESS_DENIED,
                "ACCESS_DENIED",
            );
        }

        return new GoogleAuthError(
            body.error ?? fallback,
            "ACCESS_DENIED",
        );
    }

    private saveConfig(config: GoogleSheetsConfig): void {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    }

    private saveSession(session: GoogleOAuthSession): void {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }

    private clearSession(): void {
        localStorage.removeItem(SESSION_KEY);
    }
}