export { default as GoogleSheetsPanel } from "./GoogleSheetsPanel";
export { GoogleSheetsService } from "./googleSheetsService";
export type { GoogleSheetsConfig, GoogleOAuthSession, DailyYieldMetric } from "./types";

// Error model — consumers can import the class, codes, messages, and helpers
// from a single location rather than reaching into the internals.
export {
  GoogleAuthError,
  classifyGoogleError,
  parseOAuthCallbackError,
  GOOGLE_AUTH_MESSAGES,
  GOOGLE_AUTH_REMEDIATION,
  GOOGLE_AUTH_REQUIRES_RECONNECT,
  REQUIRED_SHEETS_SCOPE,
} from "./errors";
export type { GoogleAuthErrorCode } from "./errors";

export { computeDryRunSyncPlan, buildRowKey, rowKeyToString } from "./dryRunSync";
export type {
  SheetRowAction,
  SheetRowKey,
  ExistingSheetRow,
  SyncRowPlan,
  DryRunSyncSummary,
} from "./dryRunSync";
