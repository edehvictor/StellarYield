import { Clock, AlertCircle, CheckCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DataCompletenessStatus } from './types';

interface DataFreshnessIndicatorProps {
  timestamp: string;
  nextUpdateAt: string;
  dataCompleteness: DataCompletenessStatus;
  lastUpdate: Date | null;
}

/**
 * DataFreshnessIndicator displays last update timestamp, next update countdown,
 * data completeness status, and warnings for stale or partial data.
 * 
 * Requirements: 4.5, 7.5
 */
export default function DataFreshnessIndicator({
  timestamp,
  nextUpdateAt,
  dataCompleteness,
  lastUpdate,
}: DataFreshnessIndicatorProps) {
  const [countdown, setCountdown] = useState<string>('');

  useEffect(() => {
    const updateCountdown = () => {
      const now = new Date();
      const next = new Date(nextUpdateAt);
      const diff = next.getTime() - now.getTime();

      if (diff <= 0) {
        setCountdown('Updating...');
        return;
      }

      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;

      if (minutes > 0) {
        setCountdown(`${minutes}m ${remainingSeconds}s`);
      } else {
        setCountdown(`${remainingSeconds}s`);
      }
    };

    updateCountdown();
    const intervalId = setInterval(updateCountdown, 1000);

    return () => clearInterval(intervalId);
  }, [nextUpdateAt]);

  const formatTimestamp = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const hasIssues = dataCompleteness.isStale || 
                    dataCompleteness.missingProtocols.length > 0 ||
                    !dataCompleteness.poolDepthAvailable ||
                    !dataCompleteness.routeDataAvailable;

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between gap-6">
        {/* Left Section: Timestamps */}
        <div className="flex-1 space-y-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-slate-700/50 p-2 text-gray-400">
              <Clock size={20} />
            </div>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">
                Last Updated
              </p>
              <p className="text-sm font-semibold text-white">
                {formatTimestamp(timestamp)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-500/20 p-2 text-indigo-400">
              <Clock size={20} />
            </div>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">
                Next Update In
              </p>
              <p className="text-sm font-semibold text-white">
                {countdown}
              </p>
            </div>
          </div>
        </div>

        {/* Right Section: Data Completeness */}
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
            Data Status
          </h4>

          {!hasIssues && (
            <div className="flex items-start gap-3 bg-green-950/30 border border-green-500/40 rounded-lg p-4">
              <CheckCircle size={20} className="text-green-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-green-400 mb-1">
                  All Systems Operational
                </p>
                <p className="text-xs text-green-200/80">
                  All data sources are available and up to date
                </p>
              </div>
            </div>
          )}

          {hasIssues && (
            <div className="space-y-3">
              {dataCompleteness.isStale && (
                <div className="flex items-start gap-3 bg-amber-950/30 border border-amber-500/40 rounded-lg p-4">
                  <AlertCircle size={20} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-400 mb-1">
                      Stale Data
                    </p>
                    <p className="text-xs text-amber-200/80">
                      Data has not been updated since {dataCompleteness.staleSince && formatTimestamp(dataCompleteness.staleSince)}
                    </p>
                  </div>
                </div>
              )}

              {!dataCompleteness.poolDepthAvailable && (
                <div className="flex items-start gap-3 bg-red-950/30 border border-red-500/40 rounded-lg p-4">
                  <AlertCircle size={20} className="text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-red-400 mb-1">
                      Pool Depth Data Unavailable
                    </p>
                    <p className="text-xs text-red-200/80">
                      Unable to fetch pool depth data from protocols
                    </p>
                  </div>
                </div>
              )}

              {!dataCompleteness.routeDataAvailable && (
                <div className="flex items-start gap-3 bg-amber-950/30 border border-amber-500/40 rounded-lg p-4">
                  <AlertCircle size={20} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-400 mb-1">
                      Route Data Unavailable
                    </p>
                    <p className="text-xs text-amber-200/80">
                      Routing metrics calculated from TVL distribution only
                    </p>
                  </div>
                </div>
              )}

              {dataCompleteness.missingProtocols.length > 0 && (
                <div className="flex items-start gap-3 bg-amber-950/30 border border-amber-500/40 rounded-lg p-4">
                  <AlertCircle size={20} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-400 mb-1">
                      Partial Protocol Data
                    </p>
                    <p className="text-xs text-amber-200/80">
                      Missing data for: {dataCompleteness.missingProtocols.join(', ')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
