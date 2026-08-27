/**
 * Real-Time Vault Rebalance Explanation Feed Component
 * 
 * Displays recent rebalance events with:
 * - Before/after allocation breakdowns
 * - Trigger reasons
 * - Expected outcomes
 * - Risk notes
 */

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  AlertCircle,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Eye,
  EyeOff,
  Loader,
} from "lucide-react";
import EmptyState from "./common/EmptyState";
import { EMPTY_STATE_REBALANCE } from "../utils/emptyStateCopy";
import type {
  RebalanceEvent,
  RebalanceAllocation,
} from "../../../shared/types/rebalanceEvent";
import { calculateAllocationDelta } from "../../../shared/types/rebalanceEvent";
import { RebalanceFeedService } from "../services/rebalanceFeedService";

interface RebalanceFeedProps {
  vaultId: string;
  vaultName?: string;
  maxEvents?: number;
  pollInterval?: number; // milliseconds
  enablePolling?: boolean;
  enableSSE?: boolean; // Server-Sent Events
}

interface RebalanceFeedState {
  events: RebalanceEvent[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
}

/**
 * Component to display a single rebalance event
 */
function RebalanceEventCard({
  event,
  onExpand,
}: {
  event: RebalanceEvent;
  onExpand: (eventId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const triggerReasonLabel = event.triggerReason
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  const handleExpand = () => {
    setExpanded(!expanded);
    onExpand(event.id);
  };

  return (
    <div className="border border-slate-200 rounded-lg p-4 mb-4 bg-white hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <h4 className="font-semibold text-slate-900">{event.vaultName}</h4>
          <p className="text-sm text-slate-500">
            {new Date(event.timestamp).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-1 rounded text-xs font-medium ${
              event.expectedOutcome.apyChangePercent > 0
                ? "bg-green-100 text-green-700"
                : "bg-red-100 text-red-700"
            }`}
          >
            {event.expectedOutcome.apyChangePercent > 0 ? "+" : ""}
            {event.expectedOutcome.apyChangePercent.toFixed(2)}% APY
          </span>
          <button
            onClick={handleExpand}
            className="p-1 hover:bg-slate-100 rounded transition-colors"
          >
            {expanded ? (
              <EyeOff className="w-4 h-4 text-slate-600" />
            ) : (
              <Eye className="w-4 h-4 text-slate-600" />
            )}
          </button>
        </div>
      </div>

      {/* Trigger Reason & Expected Gain */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-blue-50 p-3 rounded">
          <p className="text-xs text-blue-600 font-medium">Trigger Reason</p>
          <p className="text-sm text-blue-900">{triggerReasonLabel}</p>
          {event.triggerDetails.driftPercentage && (
            <p className="text-xs text-blue-700 mt-1">
              Drift: {Math.abs(event.triggerDetails.driftPercentage).toFixed(2)}%
            </p>
          )}
        </div>
        <div className="bg-emerald-50 p-3 rounded">
          <p className="text-xs text-emerald-600 font-medium">Expected Gain</p>
          <p className="text-sm font-semibold text-emerald-900">
            ${event.expectedOutcome.estimatedGainUsd.toFixed(2)}
          </p>
          <p className="text-xs text-emerald-700 mt-1">
            Risk Score: {event.expectedOutcome.riskScore.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Status Badge */}
      <div className="mb-3">
        <span
          className={`px-2 py-1 rounded text-xs font-medium ${
            event.executionStatus === "completed"
              ? "bg-green-100 text-green-700"
              : event.executionStatus === "pending"
                ? "bg-yellow-100 text-yellow-700"
                : "bg-red-100 text-red-700"
          }`}
        >
          {event.executionStatus.charAt(0).toUpperCase() +
            event.executionStatus.slice(1)}
        </span>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-slate-200 pt-4 mt-4 space-y-4">
          {/* Before/After Allocations */}
          <div className="grid grid-cols-2 gap-4">
            {/* Before */}
            <div className="bg-slate-50 p-3 rounded">
              <h5 className="text-sm font-semibold text-slate-900 mb-2">
                Before Allocation
              </h5>
              <div className="space-y-2">
                {event.beforeAllocation.map((alloc, idx) => (
                  <div key={idx} className="flex justify-between items-center">
                    <span className="text-xs text-slate-600">{alloc.protocol}</span>
                    <div className="text-right">
                      <p className="text-xs font-semibold text-slate-900">
                        {alloc.percentage.toFixed(1)}%
                      </p>
                      <p className="text-xs text-slate-500">
                        ${alloc.amount.toFixed(0)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2 pt-2 border-t">
                Total: ${event.beforeTotalValue.toFixed(2)}
              </p>
            </div>

            {/* After */}
            <div className="bg-emerald-50 p-3 rounded">
              <h5 className="text-sm font-semibold text-emerald-900 mb-2">
                After Allocation
              </h5>
              <div className="space-y-2">
                {event.afterAllocation.map((alloc, idx) => (
                  <div key={idx} className="flex justify-between items-center">
                    <span className="text-xs text-emerald-700">{alloc.protocol}</span>
                    <div className="text-right">
                      <p className="text-xs font-semibold text-emerald-900">
                        {alloc.percentage.toFixed(1)}%
                      </p>
                      <p className="text-xs text-emerald-600">
                        ${alloc.amount.toFixed(0)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-emerald-700 mt-2 pt-2 border-t font-medium">
                Total: ${event.afterTotalValue.toFixed(2)}
              </p>
            </div>
          </div>

          {/* Allocation Changes */}
          <div className="bg-slate-50 p-3 rounded">
            <h5 className="text-sm font-semibold text-slate-900 mb-2">Changes</h5>
            <div className="space-y-1">
              {Object.entries(calculateAllocationDelta(
                event.beforeAllocation,
                event.afterAllocation
              )).map(([protocol, delta]) => (
                <div key={protocol} className="flex justify-between items-center">
                  <span className="text-xs text-slate-600">{protocol}</span>
                  <span
                    className={`text-xs font-semibold ${
                      delta > 0 ? "text-green-600" : delta < 0 ? "text-red-600" : "text-slate-600"
                    }`}
                  >
                    {delta > 0 ? "+" : ""}{delta.toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Risk Notes */}
          {event.riskNotes.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 p-3 rounded">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h5 className="text-sm font-semibold text-amber-900">Risk Notes</h5>
                  <ul className="text-xs text-amber-800 space-y-1 mt-1">
                    {event.riskNotes.map((note, idx) => (
                      <li key={idx}>• {note}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Execution Details */}
          {event.executionDetails && (
            <div className="bg-slate-50 p-3 rounded">
              <h5 className="text-sm font-semibold text-slate-900 mb-2">
                Execution Details
              </h5>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {event.executionDetails.gasCost && (
                  <p>
                    <span className="text-slate-500">Gas Cost:</span>
                    <span className="ml-1 font-semibold text-slate-900">
                      ${event.executionDetails.gasCost.toFixed(2)}
                    </span>
                  </p>
                )}
                {event.executionDetails.slippagePercent && (
                  <p>
                    <span className="text-slate-500">Slippage:</span>
                    <span className="ml-1 font-semibold text-slate-900">
                      {event.executionDetails.slippagePercent.toFixed(2)}%
                    </span>
                  </p>
                )}
                {event.executionDetails.actualGainUsd && (
                  <p>
                    <span className="text-slate-500">Actual Gain:</span>
                    <span className="ml-1 font-semibold text-green-600">
                      ${event.executionDetails.actualGainUsd.toFixed(2)}
                    </span>
                  </p>
                )}
                {event.executionDetails.transactionHash && (
                  <p className="col-span-2">
                    <span className="text-slate-500">Tx Hash:</span>
                    <span className="ml-1 text-slate-900 truncate">
                      {event.executionDetails.transactionHash.slice(0, 16)}...
                    </span>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Main RebalanceFeed component
 */
export function RebalanceFeed({
  vaultId,
  vaultName = "Vault",
  maxEvents = 10,
  pollInterval = 30000,
  enablePolling = true,
  enableSSE = false,
}: RebalanceFeedProps) {
  const [state, setState] = useState<RebalanceFeedState>({
    events: [],
    loading: true,
    error: null,
    lastUpdated: null,
  });

  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Initial fetch
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        const result = await RebalanceFeedService.fetchRecentRebalances(
          vaultId,
          maxEvents
        );
        setState((prev) => ({
          ...prev,
          events: result.events,
          loading: false,
          lastUpdated: new Date(result.timestamp),
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          error: `Failed to load rebalance events: ${error}`,
          loading: false,
        }));
      }
    };

    fetchEvents();
  }, [vaultId, maxEvents]);

  // Set up polling or SSE
  useEffect(() => {
    if (!enablePolling && !enableSSE) return;

    if (enableSSE && !enablePolling) {
      // Use Server-Sent Events
      unsubscribeRef.current = RebalanceFeedService.subscribeToRebalanceUpdates(
        vaultId,
        (newEvent) => {
          setState((prev) => ({
            ...prev,
            events: [newEvent, ...prev.events].slice(0, maxEvents),
            lastUpdated: new Date(),
          }));
        },
        (error) => {
          setState((prev) => ({
            ...prev,
            error: `Connection error: ${error.message}`,
          }));
        }
      );
    } else {
      // Use polling
      unsubscribeRef.current = RebalanceFeedService.startPolling(
        vaultId,
        (newEvents, hasError) => {
          if (hasError) {
            setState((prev) => ({
              ...prev,
              error: "Failed to fetch latest rebalance events",
            }));
          } else if (newEvents.length > 0) {
            setState((prev) => ({
              ...prev,
              events: [...newEvents, ...prev.events].slice(0, maxEvents),
              lastUpdated: new Date(),
              error: null,
            }));
          }
        },
        pollInterval
      );
    }

    return () => {
      unsubscribeRef.current?.();
    };
  }, [vaultId, maxEvents, enablePolling, enableSSE, pollInterval]);

  const handleExpandEvent = useCallback((eventId: string) => {
    // Could be used to track analytics or other side effects
  }, []);

  const handleRefresh = async () => {
    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      const result = await RebalanceFeedService.fetchRecentRebalances(
        vaultId,
        maxEvents
      );
      setState((prev) => ({
        ...prev,
        events: result.events,
        loading: false,
        lastUpdated: new Date(result.timestamp),
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: `Refresh failed: ${error}`,
        loading: false,
      }));
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Rebalance History</h3>
          <p className="text-sm text-slate-500">{vaultName}</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={state.loading}
          className="p-2 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw
            className={`w-5 h-5 text-slate-600 ${state.loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {/* Last Updated */}
      {state.lastUpdated && (
        <p className="text-xs text-slate-500 mb-3">
          Last updated: {state.lastUpdated.toLocaleTimeString()}
        </p>
      )}

      {/* Error State */}
      {state.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-700">{state.error}</p>
        </div>
      )}

      {/* Loading State */}
      {state.loading && state.events.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-6 h-6 text-slate-400 animate-spin" />
          <p className="text-sm text-slate-500 ml-2">Loading rebalance events...</p>
        </div>
      )}

      {/* Empty State */}
      {!state.loading && state.events.length === 0 && (
        <div className="border border-dashed border-slate-300 rounded-lg p-8">
          <EmptyState
            icon={<TrendingUp className="text-slate-300" size={48} />}
            title={EMPTY_STATE_REBALANCE.title}
            description={EMPTY_STATE_REBALANCE.description}
            testId="rebalance-empty-state"
          />
        </div>
      )}

      {/* Events List */}
      <div>
        {state.events.map((event) => (
          <RebalanceEventCard
            key={event.id}
            event={event}
            onExpand={handleExpandEvent}
          />
        ))}
      </div>
    </div>
  );
}
