import { useEffect, useState } from "react";
import { Download, AlertTriangle } from "lucide-react";

const STORAGE_KEY = "stellar_yield_portfolio_export_privacy_warning_dismissed";

function readWarningDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveWarningDismissed(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // Ignore storage failures intentionally.
  }
}

interface PortfolioExportProps {
  walletAddress: string;
}

export default function PortfolioExport({ walletAddress }: PortfolioExportProps) {
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [rememberWarning, setRememberWarning] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWarningDismissed(readWarningDismissed());
  }, []);

  const downloadFile = async () => {
    setError(null);
    setIsExporting(true);

    try {
      const response = await fetch(
        `/api/users/${encodeURIComponent(walletAddress)}/export`,
      );

      if (!response.ok) {
        let message = "Failed to generate export.";
        try {
          const body = await response.json();
          if (body?.message) message = body.message;
        } catch {
          // ignore JSON parse errors
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const filename =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="(.+)"/)?.[1] ?? "portfolio-export.csv";

      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(anchor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate export.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportClick = () => {
    if (warningDismissed) {
      void downloadFile();
      return;
    }

    setShowWarningModal(true);
  };

  const handleConfirmExport = async () => {
    if (rememberWarning) {
      saveWarningDismissed();
      setWarningDismissed(true);
    }
    setShowWarningModal(false);
    await downloadFile();
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={handleExportClick}
        disabled={isExporting}
        className="btn-secondary flex items-center gap-2 text-sm"
      >
        <Download size={14} />
        Export Portfolio
      </button>

      {error ? (
        <p className="text-right text-sm text-red-400">{error}</p>
      ) : null}

      {showWarningModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="portfolio-export-warning-title"
            className="w-full max-w-lg rounded-[32px] border border-slate-800 bg-slate-950 p-6 text-white shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-orange-500/10 p-3 text-orange-300">
                <AlertTriangle size={20} />
              </div>
              <div className="space-y-3">
                <div>
                  <h2 className="text-xl font-semibold">Portfolio export privacy warning</h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Your export may include wallet address, portfolio balances, asset details, and transaction history.
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
                  <p className="font-semibold text-slate-100">What will be included</p>
                  <ul className="mt-2 space-y-2 list-disc pl-5">
                    <li>Wallet address and account identifier</li>
                    <li>Asset holdings and current balances</li>
                    <li>Recent portfolio transaction history</li>
                  </ul>
                </div>

                <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={rememberWarning}
                    onChange={(event) => setRememberWarning(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-slate-100"
                  />
                  Don't show this warning again
                </label>

                <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setShowWarningModal(false)}
                    className="w-full rounded-2xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-500 sm:w-auto"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmExport}
                    disabled={isExporting}
                    className="w-full rounded-2xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-200 disabled:opacity-60 sm:w-auto"
                  >
                    Confirm export
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
