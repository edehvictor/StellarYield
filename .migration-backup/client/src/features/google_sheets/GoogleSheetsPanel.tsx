/**
 * Google Sheets Integration Panel
 * Settings for linking Google account and managing spreadsheet sync
 */

import { useState, useEffect, useCallback } from "react";
import {
  Link2,
  Unlink2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Eye,
  Wifi,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { GoogleSheetsService } from "./googleSheetsService";
import type { GoogleSheetsConfig, DailyYieldMetric } from "./types";
import type { DryRunSyncSummary } from "./dryRunSync";
import type { GoogleAuthErrorCode } from "./errors";
import { GoogleAuthError, GOOGLE_AUTH_MESSAGES, GOOGLE_AUTH_REMEDIATION, GOOGLE_AUTH_REQUIRES_RECONNECT } from "./errors";

export interface GoogleSheetsPanelProps {
  walletAddress: string | null;
  /** Metrics that would be written on the next sync, used to power the dry-run preview (#962). */
  pendingMetrics?: DailyYieldMetric[];
}

// ---------------------------------------------------------------------------
// Per-code error banner
// ---------------------------------------------------------------------------

const CODE_ICON: Record<GoogleAuthErrorCode, React.ReactElement> = {
  OAUTH_DENIED:      <XCircle className="w-5 h-5 text-amber-500 shrink-0" />,
  TOKEN_EXPIRED:     <RefreshCw className="w-5 h-5 text-amber-500 shrink-0" />,
  REAUTH_REQUIRED:   <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />,
  INSUFFICIENT_SCOPE:<AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />,
  ACCESS_DENIED:     <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />,
  NETWORK_ERROR:     <Wifi className="w-5 h-5 text-yellow-500 shrink-0" />,
};

const CODE_TITLE: Record<GoogleAuthErrorCode, string> = {
  OAUTH_DENIED:       "Sign-In Cancelled",
  TOKEN_EXPIRED:      "Session Expired",
  REAUTH_REQUIRED:    "Reconnection Required",
  INSUFFICIENT_SCOPE: "Missing Sheets Permission",
  ACCESS_DENIED:      "Access Denied",
  NETWORK_ERROR:      "Network Error",
};

function AuthErrorBanner({
  code,
  onReconnect,
}: {
  code: GoogleAuthErrorCode;
  onReconnect: () => void;
}) {
  const canReconnect = GOOGLE_AUTH_REQUIRES_RECONNECT[code];
  return (
    <div className="flex items-start gap-3 p-4 mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
      {CODE_ICON[code]}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-amber-400">{CODE_TITLE[code]}</p>
        <p className="text-sm text-gray-300 mt-0.5">{GOOGLE_AUTH_MESSAGES[code]}</p>
        <p className="text-xs text-gray-400 mt-1">{GOOGLE_AUTH_REMEDIATION[code]}</p>
      </div>
      {canReconnect && (
        <button
          onClick={onReconnect}
          className="shrink-0 px-3 py-1.5 text-sm bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-lg whitespace-nowrap"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}

export default function GoogleSheetsPanel({
  walletAddress,
  pendingMetrics,
}: GoogleSheetsPanelProps) {
  const [config, setConfig] = useState<GoogleSheetsConfig | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [sheetName, setSheetName] = useState("Yield Metrics");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [authStatus, setAuthStatus] = useState<
    "connected" | "expired" | "missing_scope" | "not_connected"
  >("not_connected");
  const [activeErrorCode, setActiveErrorCode] = useState<GoogleAuthErrorCode | null>(null);
  const [dryRunSummary, setDryRunSummary] = useState<DryRunSyncSummary | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState("");
  const [dryRunErrorCode, setDryRunErrorCode] = useState<GoogleAuthErrorCode | null>(null);

  // Only the public client_id is needed here; the client secret lives
  // server-side inside /api/google-sheets/token (process.env.GOOGLE_CLIENT_SECRET).
  const service = new GoogleSheetsService(
    import.meta.env.VITE_GOOGLE_CLIENT_ID || "",
    `${window.location.origin}/auth/google-sheets/callback`,
  );

  // Load config and auth status on mount
  useEffect(() => {
    setConfig(service.getConfig());
    setAuthStatus(service.getAuthStatus());
  }, []);

  const handleConnectGoogle = useCallback(() => {
    const authUrl = service.getAuthorizationUrl();
    window.location.href = authUrl;
  }, []);

  const handleLinkSpreadsheet = useCallback(async () => {
    if (!spreadsheetId) {
      setError("Please enter a spreadsheet ID");
      return;
    }

    setError("");
    setSuccess("");
    setActiveErrorCode(null);
    setLoading(true);

    try {
      const newConfig = await service.linkSpreadsheet(spreadsheetId, sheetName);
      setConfig(newConfig);
      setAuthStatus(service.getAuthStatus());
      setSuccess("Spreadsheet linked successfully!");
      setSpreadsheetId("");
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        setAuthStatus(service.getAuthStatus());
        setActiveErrorCode(err.code);
        setError(GOOGLE_AUTH_MESSAGES[err.code] ?? err.message);
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to link spreadsheet",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [spreadsheetId, sheetName]);

  const handleUnlink = useCallback(() => {
    if (confirm("Unlink Google Sheets? Daily syncs will stop.")) {
      service.unlinkAccount();
      setConfig(null);
      setAuthStatus("not_connected");
      setSuccess("Google Sheets unlinked");
    }
  }, []);

  const handlePreviewSync = useCallback(async () => {
    if (!pendingMetrics || pendingMetrics.length === 0) return;

    setDryRunError("");
    setDryRunErrorCode(null);
    setDryRunSummary(null);
    setDryRunLoading(true);

    try {
      const summary = await service.previewSync(pendingMetrics);
      setDryRunSummary(summary);
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        setAuthStatus(service.getAuthStatus());
        setDryRunErrorCode(err.code);
        setDryRunError(GOOGLE_AUTH_MESSAGES[err.code] ?? err.message);
      } else {
        setDryRunError(
          err instanceof Error ? err.message : "Failed to preview sync",
        );
      }
    } finally {
      setDryRunLoading(false);
    }
  }, [pendingMetrics]);

  return (
    <div className="space-y-6">
      {/* Status Card */}
      <div className="glass-panel p-6">
        <h2 className="text-xl font-semibold mb-4">
          Google Sheets Integration
        </h2>

        {/* Unified auth error banner — renders for any GoogleAuthErrorCode */}
        {activeErrorCode ? (
          <AuthErrorBanner code={activeErrorCode} onReconnect={handleConnectGoogle} />
        ) : (
          <>
            {authStatus === "expired" && (
              <AuthErrorBanner code="REAUTH_REQUIRED" onReconnect={handleConnectGoogle} />
            )}
            {authStatus === "missing_scope" && (
              <AuthErrorBanner code="INSUFFICIENT_SCOPE" onReconnect={handleConnectGoogle} />
            )}
          </>
        )}

        {config?.isLinked ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              <div>
                <p className="font-semibold text-green-400">Connected</p>
                <p className="text-sm text-gray-400">
                  Syncing to: {config.sheetName} ({config.spreadsheetId})
                </p>
                <p className="text-xs text-gray-500">
                  Linked {new Date(config.linkedAt || 0).toLocaleDateString()}
                </p>
              </div>
            </div>

            <button
              onClick={handleUnlink}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 rounded-lg font-medium"
            >
              <Unlink2 className="w-4 h-4" />
              Unlink Account
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-gray-400">
              Connect your Google account to automatically sync daily yield
              metrics to a spreadsheet.
            </p>

            <button
              onClick={handleConnectGoogle}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold"
            >
              <Link2 className="w-5 h-5" />
              Connect Google Account
            </button>
          </div>
        )}
      </div>

      {/* Link Spreadsheet Form */}
      {config?.isLinked ? (
        <div className="glass-panel p-6 space-y-4">
          <h3 className="text-lg font-semibold">Sync Settings</h3>
          <div className="p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
            <p className="text-sm text-blue-400">
              Daily yield metrics are automatically synced to your spreadsheet
              every night at 12:00 AM UTC.
            </p>
          </div>

          {pendingMetrics && pendingMetrics.length > 0 && (
            <div className="space-y-3" data-testid="dry-run-section">
              <button
                onClick={() => void handlePreviewSync()}
                disabled={dryRunLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-50 text-white rounded-lg font-medium"
              >
                {dryRunLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Previewing sync...
                  </>
                ) : (
                  <>
                    <Eye className="w-4 h-4" />
                    Preview Sync ({pendingMetrics.length} row
                    {pendingMetrics.length !== 1 ? "s" : ""})
                  </>
                )}
              </button>

              {dryRunError && (
                <div className="space-y-1">
                  {dryRunErrorCode ? (
                    <AuthErrorBanner code={dryRunErrorCode} onReconnect={handleConnectGoogle} />
                  ) : (
                    <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                      <AlertCircle className="w-5 h-5 text-red-500" />
                      <span className="text-sm text-red-400">{dryRunError}</span>
                    </div>
                  )}
                </div>
              )}

              {dryRunSummary && (
                <div
                  className="p-4 bg-black/30 border border-white/10 rounded-lg space-y-3"
                  data-testid="dry-run-summary"
                >
                  <p className="text-sm font-semibold text-gray-200">
                    Dry-run preview — nothing has been written yet
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="flex items-center justify-between px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
                      <span className="text-green-400">Added</span>
                      <span className="font-mono text-green-300">{dryRunSummary.added.length}</span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                      <span className="text-blue-400">Updated</span>
                      <span className="font-mono text-blue-300">{dryRunSummary.updated.length}</span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2 bg-gray-500/10 border border-gray-500/20 rounded-lg">
                      <span className="text-gray-400">Skipped</span>
                      <span className="font-mono text-gray-300">{dryRunSummary.skipped.length}</span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                      <span className="text-amber-400">Conflicted</span>
                      <span className="font-mono text-amber-300">{dryRunSummary.conflicted.length}</span>
                    </div>
                  </div>

                  {dryRunSummary.conflicted.length > 0 && (
                    <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-300">
                        {dryRunSummary.conflicted.length} row
                        {dryRunSummary.conflicted.length !== 1 ? "s" : ""} disagree
                        with data already in the sheet and will be skipped by a
                        real sync. Resolve them in the spreadsheet before
                        committing.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="glass-panel p-6 space-y-4">
          <h3 className="text-lg font-semibold">Link Spreadsheet</h3>

          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Spreadsheet ID
            </label>
            <input
              type="text"
              value={spreadsheetId}
              onChange={(e) => setSpreadsheetId(e.target.value)}
              placeholder="Paste Google Sheets ID from URL"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Find it in your spreadsheet URL: docs.google.com/spreadsheets/d/
              <span className="font-mono">YOUR_ID_HERE</span>/edit
            </p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Sheet Name
            </label>
            <input
              type="text"
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              placeholder="e.g., Yield Metrics"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
            />
          </div>

          {error && (
            <div>
              {activeErrorCode ? (
                <AuthErrorBanner code={activeErrorCode} onReconnect={handleConnectGoogle} />
              ) : (
                <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <span className="text-sm text-red-400">{error}</span>
                </div>
              )}
            </div>
          )}

          {success && (
            <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              <span className="text-sm text-green-400">{success}</span>
            </div>
          )}

          <button
            onClick={handleLinkSpreadsheet}
            disabled={loading || !spreadsheetId}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 text-white rounded-lg font-semibold"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Linking...
              </>
            ) : (
              <>
                <Link2 className="w-5 h-5" />
                Link Spreadsheet
              </>
            )}
          </button>
        </div>
      )}

      {/* Info Card */}
      <div className="glass-panel p-6 space-y-3">
        <h3 className="text-lg font-semibold">What Gets Synced?</h3>
        <ul className="space-y-2 text-sm text-gray-400">
          <li className="flex gap-2">
            <span className="text-purple-400">•</span>
            <span>Daily date and vault name</span>
          </li>
          <li className="flex gap-2">
            <span className="text-purple-400">•</span>
            <span>Deposit amount and current value</span>
          </li>
          <li className="flex gap-2">
            <span className="text-purple-400">•</span>
            <span>Daily yield earned and APY</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
