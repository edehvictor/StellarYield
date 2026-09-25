import { useState } from "react";
import { useWallet } from "../../context/useWallet";
import {
  FileSpreadsheet,
  Download,
  Loader2,
  AlertCircle,
  Eye,
  AlertTriangle,
} from "lucide-react";
import { getApiBaseUrl } from "../../lib/api";

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

type PreviewWarningCode =
  | "MISSING_BASIS"
  | "MISSING_TIMESTAMP"
  | "UNSUPPORTED_TOKEN";

interface TaxLotPreviewRow {
  date: string | null;
  action: string;
  asset: string;
  amount: number;
  costBasisUsd: number | null;
  realizedYieldUsd: number | null;
  txHash: string;
  warnings: PreviewWarningCode[];
}

interface PreviewWarning {
  code: PreviewWarningCode;
  message: string;
  rowIndex: number | null;
}

interface TaxLotPreview {
  rows: TaxLotPreviewRow[];
  warnings: PreviewWarning[];
  totals: {
    costBasisUsd: number;
    realizedYieldUsd: number;
    rows: number;
  };
  canDownload: boolean;
}

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function formatAmount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 7 });
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return value;
  }
}

const WARNING_LABEL: Record<PreviewWarningCode, string> = {
  MISSING_BASIS: "missing basis",
  MISSING_TIMESTAMP: "missing timestamp",
  UNSUPPORTED_TOKEN: "unsupported token",
};

/**
 * TaxExport — "Generate Tax Report" UI component for the settings page.
 *
 * The export now happens in two steps. First the user previews their tax
 * lots (cost basis, realized yield, and any warning conditions). Only when
 * the preview succeeds without blocking warnings does the CSV download
 * button activate, so users no longer download silently incomplete files.
 */
export default function TaxExport() {
  const { isConnected, walletAddress } = useWallet();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TaxLotPreview | null>(null);
  const [success, setSuccess] = useState(false);

  const resetState = () => {
    setError(null);
    setSuccess(false);
  };

  const handlePreview = async () => {
    if (!walletAddress) return;
    resetState();
    setPreview(null);
    setPreviewLoading(true);
    try {
      const res = await fetch(
        `${getApiBase()}/api/users/${encodeURIComponent(walletAddress)}/export/preview`,
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
        throw new Error("Failed to generate preview");
      }
      const data: TaxLotPreview = await res.json();
      setPreview(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate preview",
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!walletAddress || !preview?.canDownload) return;
    resetState();
    setDownloading(true);
    try {
      const res = await fetch(
        `${getApiBase()}/api/users/${encodeURIComponent(walletAddress)}/export`,
      );
      if (res.status === 404) {
        setError("No transactions found for your address.");
        return;
      }
      if (res.status === 409) {
        setError(
          "The preview surfaced warnings that block the download. Refresh the preview and resolve them upstream.",
        );
        return;
      }
      if (res.status === 429) {
        setError("Too many requests. Please try again in a few minutes.");
        return;
      }
      if (!res.ok) {
        throw new Error("Failed to generate export");
      }

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
      setDownloading(false);
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
        Preview your tax lots — cost basis, realized yield, and any warning
        conditions — before downloading the CSV. The download only unlocks
        when the preview is clean.
      </p>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4"
        >
          <AlertCircle className="text-red-400 shrink-0" size={18} />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {success && (
        <div
          role="status"
          className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-xl p-3 mb-4"
        >
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
        onClick={() => void handlePreview()}
        disabled={previewLoading}
        className="w-full py-3 mb-4 bg-white/5 hover:bg-white/10 text-white font-bold rounded-xl transition-all border border-white/10 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {previewLoading ? (
          <>
            <Loader2 className="animate-spin" size={18} />
            Generating Preview...
          </>
        ) : (
          <>
            <Eye size={18} />
            {preview ? "Refresh Preview" : "Preview Tax Lots"}
          </>
        )}
      </button>

      {preview && (
        <div className="mb-6" data-testid="tax-preview">
          <div className="flex flex-wrap gap-3 mb-3 text-xs text-gray-300">
            <span>Rows: {preview.totals.rows}</span>
            <span>Cost basis: {formatUsd(preview.totals.costBasisUsd)}</span>
            <span>
              Realized yield: {formatUsd(preview.totals.realizedYieldUsd)}
            </span>
          </div>

          {preview.warnings.length > 0 && (
            <div className="mb-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-yellow-200 text-xs">
              <div className="flex items-center gap-2 mb-2 font-semibold">
                <AlertTriangle size={14} />
                <span>{preview.warnings.length} warning(s) found</span>
              </div>
              <ul className="list-disc pl-5 space-y-1">
                {preview.warnings.slice(0, 8).map((w, i) => (
                  <li key={`${w.code}-${i}`}>
                    <span className="uppercase tracking-wide mr-1">
                      [{WARNING_LABEL[w.code]}]
                    </span>
                    {w.message}
                  </li>
                ))}
                {preview.warnings.length > 8 && (
                  <li>…and {preview.warnings.length - 8} more.</li>
                )}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-xs text-left">
              <thead className="bg-white/5 text-gray-400 uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Asset</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-right">Cost basis</th>
                  <th className="px-3 py-2 text-right">Realized yield</th>
                  <th className="px-3 py-2">Warnings</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 50).map((row, i) => (
                  <tr key={`${row.txHash}-${i}`} className="border-t border-white/5">
                    <td className="px-3 py-2 text-gray-300">
                      {formatDate(row.date)}
                    </td>
                    <td className="px-3 py-2 text-white">{row.action}</td>
                    <td className="px-3 py-2 text-gray-300">{row.asset}</td>
                    <td className="px-3 py-2 text-right text-white font-mono">
                      {formatAmount(row.amount)}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-300 font-mono">
                      {formatUsd(row.costBasisUsd)}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-300 font-mono">
                      {formatUsd(row.realizedYieldUsd)}
                    </td>
                    <td className="px-3 py-2 text-yellow-300">
                      {row.warnings.length === 0
                        ? "—"
                        : row.warnings
                            .map((c) => WARNING_LABEL[c])
                            .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length > 50 && (
              <p className="px-3 py-2 text-xs text-gray-400">
                Showing first 50 of {preview.rows.length} rows. The full set
                is included in the CSV.
              </p>
            )}
          </div>
        </div>
      )}

      <button
        onClick={() => void handleDownload()}
        disabled={!preview?.canDownload || downloading}
        className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {downloading ? (
          <>
            <Loader2 className="animate-spin" size={18} />
            Generating Report...
          </>
        ) : (
          <>
            <Download size={18} />
            {preview?.canDownload
              ? "Download Tax Report"
              : preview
                ? "Resolve warnings to download"
                : "Preview required before download"}
          </>
        )}
      </button>
    </div>
  );
}
