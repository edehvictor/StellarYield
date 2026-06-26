/**
 * Google Sheets Integration Types
 */

export interface GoogleSheetsConfig {
    spreadsheetId: string;
    sheetName: string;
    isLinked: boolean;
    linkedAt?: number;
}

export type GoogleAuthStatus = "active" | "needs_refresh" | "needs_reconnect";

export interface GoogleOAuthSession {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email: string;
    grantedScopes?: string[];
    authStatus?: GoogleAuthStatus;
}

export interface DailyYieldMetric {
    date: string;
    vaultName: string;
    depositAmount: bigint;
    currentValue: bigint;
    dailyYield: bigint;
    apy: number;
}
