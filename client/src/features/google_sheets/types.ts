/**
 * Google Sheets Integration Types
 */

export interface GoogleSheetsConfig {
    spreadsheetId: string;
    sheetName: string;
    isLinked: boolean;
    linkedAt?: number;
}

export interface GoogleOAuthSession {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email: string;
}

export interface DailyYieldMetric {
    date: string;
    vaultName: string;
    depositAmount: bigint;
    currentValue: bigint;
    dailyYield: bigint;
    apy: number;
}
