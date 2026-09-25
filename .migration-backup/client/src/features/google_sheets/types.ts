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
    /** Wallet this metric belongs to. Used for dry-run conflict detection (#962). */
    walletAddress?: string;
    /** Asset/token symbol for this vault position. Used for dry-run conflict detection (#962). */
    asset?: string;
}
