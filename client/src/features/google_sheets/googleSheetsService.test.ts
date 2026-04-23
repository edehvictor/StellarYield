/**
 * Google Sheets Service Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoogleSheetsService } from "./googleSheetsService";

describe("GoogleSheetsService", () => {
    let service: GoogleSheetsService;

    beforeEach(() => {
        service = new GoogleSheetsService("client-id", "client-secret", "http://localhost:3000/callback");
        localStorage.clear();
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

    it("should detect expired tokens", () => {
        const expiredSession = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() - 1000, // Expired
            email: "test@example.com",
        };

        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(expiredSession));

        expect(service.getSession()).toBeNull();
    });

    it("should return valid session", () => {
        const validSession = {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000, // 1 hour from now
            email: "test@example.com",
        };

        localStorage.setItem("stellar_yield_google_oauth", JSON.stringify(validSession));

        const session = service.getSession();
        expect(session).toBeDefined();
        expect(session?.email).toBe("test@example.com");
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
