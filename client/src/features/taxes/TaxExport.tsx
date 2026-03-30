import { useState } from "react";
import { useWallet } from "../../context/useWallet";
import { FileSpreadsheet, Download, Loader2, AlertCircle } from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

/**
 * TaxExport — "Generate Tax Report" UI component for the settings page.
 *
 * Allows users to download their complete transaction history as a
 * standardized CSV file for tax reporting purposes.
 */
export default function TaxExport() {
  const { isConnected, walletAddress } = useWallet();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleExport = async () => {
    if (!walletAddress) return;
    setGenerating(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch(
        `${API_BASE}/api/users/${encodeURIComponent(walletAddress)}/export`,
      );

      if (res.status === 404) {
        setError("No transactions found for your address.");
        return;
      }

      if (res.status === 429) {
        setError("Too many requests. Please try again in a few minutes.");
        return;
      }

      if (!res.ok) {
        throw new Error("Failed to generate export");
      }

      // Download the CSV file
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers
          .get("Content-Disposition")
          ?.match(/filename="(.+)"/)?.[1] ?? "stellaryield-tax-report.csv";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      setSuccess(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate export",
      );
    } finally {
      setGenerating(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="glass-panel p-6">
        <div className="flex items-center gap-3 mb-4">
          <FileSpreadsheet className="text-indigo-400" size={24} />
          <h3 className="text-lg font-bold">Tax Report</h3>
        </div>
        <p className="text-gray-400 text-sm">
          Connect your wallet to generate a tax report.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-panel p-6">
      <div className="flex items-center gap-3 mb-4">
        <FileSpreadsheet className="text-indigo-400" size={24} />
        <h3 className="text-lg font-bold">Tax Report Export</h3>
      </div>

      <p className="text-gray-400 text-sm mb-6">
        Download your complete transaction history as a CSV file. Includes all
        deposits, withdrawals, and yield events with USD values at the time of
        each transaction.
      </p>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4">
          <AlertCircle className="text-red-400 shrink-0" size={18} />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-xl p-3 mb-4">
          <Download className="text-green-400 shrink-0" size={18} />
          <p className="text-green-400 text-sm">
            Tax report downloaded successfully!
          </p>
        </div>
      )}

      <div className="bg-white/5 rounded-xl p-4 mb-6">
        <p className="text-gray-400 text-xs mb-1">CSV Format</p>
        <p className="text-white text-sm font-mono">
          Date, Action, Asset, Amount, USD Value, TxHash
        </p>
      </div>

      <button
        onClick={() => void handleExport()}
        disabled={generating}
        className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {generating ? (
          <>
            <Loader2 className="animate-spin" size={18} />
            Generating Report...
          </>
        ) : (
          <>
            <Download size={18} />
            Generate Tax Report
          </>
        )}
      </button>
    </div>
  );
}
