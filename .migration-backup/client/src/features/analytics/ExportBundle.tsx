import React, { useState, useEffect } from 'react';
import { Download, FileJson, Loader2, CheckCircle2, AlertCircle, Clock, Info, ShieldCheck } from 'lucide-react';
import { buildExportFilename } from './exportFilename';

interface ExportMetadata {
  generatedAt: string;
  appVersion: string;
  metadata: {
    totalOpportunities: number;
    scoringMethodology: string;
    sourceFreshness: number;
    filtersApplied: Record<string, any>;
  };
}

export const ExportBundle: React.FC = () => {
  const [isExporting, setIsExporting] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExportMetadata | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(true);

  useEffect(() => {
    const fetchPreview = async () => {
      try {
        const response = await fetch('/api/strategies/export/preview');
        if (!response.ok) throw new Error('Failed to fetch preview');
        const data = await response.json();
        setPreview(data);
      } catch (err) {
        console.error('Preview fetch error:', err);
      } finally {
        setIsLoadingPreview(false);
      }
    };
    fetchPreview();
  }, []);

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
      a.download = buildExportFilename('snapshot', 'json');
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
        {isLoadingPreview ? (
          <div className="flex items-center justify-center py-4 text-slate-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            Loading bundle details...
          </div>
        ) : preview ? (
          <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-500 border-b border-slate-200 dark:border-slate-700 pb-2 mb-2">
              <span className="flex items-center gap-1">
                <Clock size={12} /> 
                Refreshed {new Date(preview.generatedAt).toLocaleTimeString()}
              </span>
              <span>v{preview.appVersion}</span>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Opportunities</p>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{preview.metadata.totalOpportunities} entries</p>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Source Freshness</p>
                <p className="text-sm font-semibold text-green-600 dark:text-green-400">
                  {Math.round(preview.metadata.sourceFreshness * 100)}%
                </p>
              </div>
            </div>

            <div className="pt-2">
              <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1">Active Methodology</p>
              <code className="text-[10px] block bg-slate-200/50 dark:bg-slate-900/50 p-2 rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400">
                {preview.metadata.scoringMethodology}
              </code>
            </div>
          </div>
        ) : null}

        <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl text-sm text-slate-600 dark:text-slate-300">
          <ul className="space-y-2">
            <li className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-blue-500" />
              Private wallet data excluded
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
