import React, { useState } from 'react';
import { Download, FileJson, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

export const ExportBundle: React.FC = () => {
  const [isExporting, setIsExporting] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setError(null);
    try {
      const response = await fetch('/api/strategies/export');
      if (!response.ok) throw new Error('Export failed');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stellar-yield-snapshot-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      setLastExport(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
            <FileJson size={24} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Data Export</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Full opportunity snapshot bundle</p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl text-sm text-slate-600 dark:text-slate-300">
          <ul className="space-y-2">
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-green-500" />
              APY & Liquidity Metrics
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-green-500" />
              Risk Scores & Confidence State
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-green-500" />
              Machine-readable JSON format
            </li>
          </ul>
        </div>

        <button
          onClick={handleExport}
          disabled={isExporting}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/20"
        >
          {isExporting ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              Generating Bundle...
            </>
          ) : (
            <>
              <Download size={20} />
              Export Snapshot
            </>
          )}
        </button>

        {lastExport && !error && (
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 justify-center">
            <CheckCircle2 size={16} />
            Last exported at {lastExport}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 justify-center">
            <AlertCircle size={16} />
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
