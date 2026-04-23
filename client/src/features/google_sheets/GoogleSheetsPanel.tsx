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
  Loader2,
} from "lucide-react";
import { GoogleSheetsService } from "./googleSheetsService";
import type { GoogleSheetsConfig } from "./types";

export interface GoogleSheetsPanelProps {
  walletAddress: string | null;
}

export default function GoogleSheetsPanel({
  walletAddress,
}: GoogleSheetsPanelProps) {
  const [config, setConfig] = useState<GoogleSheetsConfig | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [sheetName, setSheetName] = useState("Yield Metrics");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const service = new GoogleSheetsService(
    import.meta.env.VITE_GOOGLE_CLIENT_ID || "",
    import.meta.env.VITE_GOOGLE_CLIENT_SECRET || "",
    `${window.location.origin}/auth/google-sheets/callback`,
  );

  // Load config on mount
  useEffect(() => {
    setConfig(service.getConfig());
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
    setLoading(true);

    try {
      const newConfig = await service.linkSpreadsheet(spreadsheetId, sheetName);
      setConfig(newConfig);
      setSuccess("Spreadsheet linked successfully!");
      setSpreadsheetId("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to link spreadsheet",
      );
    } finally {
      setLoading(false);
    }
  }, [spreadsheetId, sheetName]);

  const handleUnlink = useCallback(() => {
    if (confirm("Unlink Google Sheets? Daily syncs will stop.")) {
      service.unlinkAccount();
      setConfig(null);
      setSuccess("Google Sheets unlinked");
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Status Card */}
      <div className="glass-panel p-6">
        <h2 className="text-xl font-semibold mb-4">
          Google Sheets Integration
        </h2>

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
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertCircle className="w-5 h-5 text-red-500" />
              <span className="text-sm text-red-400">{error}</span>
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
