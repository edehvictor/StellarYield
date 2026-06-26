/**
 * Google Sheets Service Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoogleSheetsService } from "./googleSheetsService";
import { GoogleAuthError } from "./errors";

describe("GoogleSheetsService", () => {
    let service: GoogleSheetsService;

    beforeEach(() => {
        service = new GoogleSheetsService("client-id", "http://localhost:3000/callback");
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it("should generate authorization URL", () => {
        const url = service.getAuthorizationUrl();

        expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
        expect(url).toContain("client_id=client-id");
        expect(url).toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fspreadsheets");
    });

    it("should return null for unconfigured service", () => {
        expect(service.getConfig()).toBeNull();
        expect(service.getSession()).toBeNull();
    });

    it("should detect expired tokens via getSession", () => {
        const expiredSession = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() - 1000,
            email: "test@example.com",
        };

        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(expiredSession));

        expect(service.getSession()).toBeNull();
        expect(service.getAuthStatus()).toBe("expired");
    });

    it("should return valid session", () => {
        const validSession = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000,
            email: "test@example.com",
            grantedScopes: ["https://www.googleapis.com/auth/spreadsheets"],
        };

        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(validSession));

        const session = service.getSession();
        expect(session).toBeDefined();
        expect(session?.email).toBe("test@example.com");
        expect(service.getAuthStatus()).toBe("connected");
    });

    it("should detect missing scope", () => {
        const session = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000,
            email: "test@example.com",
            grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
        };

        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(session));

        expect(service.getAuthStatus()).toBe("missing_scope");
    });

    it("should refresh expired token and return session", async () => {
        const expiredSession = {
            accessToken: "old-token",
            refreshToken: "refresh-token",
            expiresAt: Date.now() - 1000,
            email: "test@example.com",
            grantedScopes: ["https://www.googleapis.com/auth/spreadsheets"],
        };
        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(expiredSession));

        global.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                accessToken: "new-token",
                refreshToken: "refresh-token",
                expiresIn: 3600,
            }),
        });

        const session = await service.ensureValidSession();
        expect(session.accessToken).toBe("new-token");
        expect(service.getSession()?.accessToken).toBe("new-token");
    });

    it("should clear session on invalid_grant during refresh", async () => {
        const expiredSession = {
            accessToken: "old-token",
            refreshToken: "revoked-refresh",
            expiresAt: Date.now() - 1000,
            email: "test@example.com",
        };
        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(expiredSession));

        global.fetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: async () => ({
                error: "Google authorization expired or was revoked.",
                code: "REAUTH_REQUIRED",
            }),
        });

        await expect(service.refreshAccessToken()).rejects.toThrow(GoogleAuthError);
        expect(service.getRawSession()).toBeNull();
    });

    it("should surface INSUFFICIENT_SCOPE from verify endpoint", async () => {
        const validSession = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000,
            email: "test@example.com",
            grantedScopes: ["https://www.googleapis.com/auth/spreadsheets"],
        };
        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(validSession));

        global.fetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 403,
            json: async () => ({
                error: "Your Google account is missing the required Sheets permission.",
                code: "INSUFFICIENT_SCOPE",
            }),
        });

        await expect(
            service.linkSpreadsheet("sheet-id", "Metrics"),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    });

    it("should unlink account", () => {
        const config = {
            spreadsheetId: "123",
            sheetName: "Metrics",
            isLinked: true,
            linkedAt: Date.now(),
        };

        localStorage.setItem("stellar_yield_google_sheets", JSON.stringify(config));
        service.unlinkAccount();

        expect(service.getConfig()).toBeNull();
        expect(service.getSession()).toBeNull();
    });
});
