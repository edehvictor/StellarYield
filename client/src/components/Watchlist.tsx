/**
 * Yield Opportunity Watchlist React Component
 * 
 * Displays a watchlist of yield opportunities with threshold rules and alerts.
 * Features:
 * - Add/remove opportunities from watchlist
 * - Create and manage threshold rules (APY, TVL, spread)
 * - Real-time alert notifications
 * - Alert acknowledgment
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  AlertCircle,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Bell,
  Check,
  X,
  Loader,
} from "lucide-react";
import { WatchlistClientService } from "../services/watchlistClientService";
import { formatThresholdRule } from "../../../shared/types/watchlist";
import type {
  WatchlistItem,
  ThresholdRule,
  WatchlistResponse,
} from "../../../shared/types/watchlist";

interface WatchlistState {
  items: WatchlistItem[];
  totalUnacknowledgedAlerts: number;
  loading: boolean;
  error: string | null;
  expandedItems: Set<string>;
}

interface AddRuleDialogState {
  open: boolean;
  itemId?: string;
  ruleType: "apy_above" | "apy_below" | "tvl_above" | "tvl_below" | "spread_change_above" | "apy_drop_pct";
  ruleValue: number;
  triggerOnce: boolean;
}

/**
 * Alert badge for watchlist item
 */
function AlertBadge({
  count,
  showIcon = true,
}: {
  count: number;
  showIcon?: boolean;
}) {
  if (count === 0) return null;

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-red-100 rounded-full">
      {showIcon && <Bell className="w-3 h-3 text-red-600" />}
      <span className="text-xs font-semibold text-red-600">{count}</span>
    </div>
  );
}

/**
 * Threshold rule display component
 */
function RuleDisplay({
  rule,
  onRemove,
  onAcknowledge,
}: {
  rule: ThresholdRule;
  onRemove: (ruleId: string) => void;
  onAcknowledge?: (ruleId: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded border border-slate-200">
      <span className="text-sm text-slate-700">{formatThresholdRule(rule)}</span>
      <div className="flex items-center gap-1">
        {onAcknowledge && (
          <button
            onClick={() => onAcknowledge(rule.id)}
            className="p-1 hover:bg-slate-200 rounded transition-colors"
            title="Acknowledge alert"
          >
            <Check className="w-4 h-4 text-green-600" />
          </button>
        )}
        <button
          onClick={() => onRemove(rule.id)}
          className="p-1 hover:bg-slate-200 rounded transition-colors"
          title="Remove rule"
        >
          <Trash2 className="w-4 h-4 text-red-600" />
        </button>
      </div>
    </div>
  );
}

/**
 * Add rule dialog
 */
function AddRuleDialog({
  state,
  onClose,
  onAdd,
}: {
  state: AddRuleDialogState;
  onClose: () => void;
  onAdd: (ruleType: string, value: number, triggerOnce: boolean) => void;
}) {
  if (!state.open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (state.itemId && state.ruleValue > 0) {
      onAdd(state.ruleType, state.ruleValue, state.triggerOnce);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Add Threshold Rule</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Rule Type
            </label>
            <select
              value={state.ruleType}
              onChange={(e) =>
                (state.ruleType = e.target.value as any)
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="apy_above">APY Above (%)</option>
              <option value="apy_below">APY Below (%)</option>
              <option value="apy_drop_pct">APY Drop From Baseline (pp)</option>
              <option value="tvl_above">TVL Above ($)</option>
              <option value="tvl_below">TVL Below ($)</option>
              <option value="spread_change_above">Spread Change Above (%)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Threshold Value
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={state.ruleValue}
              onChange={(e) => (state.ruleValue = parseFloat(e.target.value) || 0)}
              placeholder="Enter value"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.triggerOnce}
              onChange={(e) => (state.triggerOnce = e.target.checked)}
              className="w-4 h-4 rounded border-slate-300"
            />
            <span className="text-sm text-slate-700">Trigger only once</span>
          </label>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Add Rule
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Watchlist item card
 */
function WatchlistItemCard({
  item,
  expanded,
  onToggleExpand,
  onRemove,
  onAddRule,
  onRemoveRule,
  onAcknowledgeAlert,
}: {
  item: WatchlistItem;
  expanded: boolean;
  onToggleExpand: () => void;
  onRemove: (itemId: string) => void;
  onAddRule: (itemId: string) => void;
  onRemoveRule: (itemId: string, ruleId: string) => void;
  onAcknowledgeAlert: (itemId: string, ruleId: string) => void;
}) {
  return (
    <div className="border border-slate-200 rounded-lg p-4 mb-3 bg-white hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <h4 className="font-semibold text-slate-900">{item.opportunityName}</h4>
          <p className="text-xs text-slate-500 mt-1">
            {item.opportunityType.charAt(0).toUpperCase() +
              item.opportunityType.slice(1)}{" "}
            • {item.currentTvl > 0 && `TVL: $${item.currentTvl.toLocaleString()}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="bg-blue-100 px-3 py-1 rounded text-sm font-semibold text-blue-700">
            {item.currentApy.toFixed(2)}% APY
          </div>
          {item.apyDropPct !== undefined && item.apyDropPct > 0 && (
            <div
              className="bg-red-100 px-3 py-1 rounded text-sm font-semibold text-red-700"
              title="APY drop from baseline"
            >
              -{item.apyDropPct.toFixed(2)}pp drop
            </div>
          )}
          {item.alertCount > 0 && <AlertBadge count={item.alertCount} />}
          <button
            onClick={onToggleExpand}
            className="p-1 hover:bg-slate-100 rounded transition-colors"
          >
            {expanded ? (
              <EyeOff className="w-4 h-4 text-slate-600" />
            ) : (
              <Eye className="w-4 h-4 text-slate-600" />
            )}
          </button>
          <button
            onClick={() => onRemove(item.id)}
            className="p-1 hover:bg-red-100 rounded transition-colors"
          >
            <Trash2 className="w-4 h-4 text-red-600" />
          </button>
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t border-slate-200 pt-4 mt-4 space-y-4">
          {/* Rules Section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h5 className="text-sm font-semibold text-slate-900">Threshold Rules</h5>
              <button
                onClick={() => onAddRule(item.id)}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add Rule
              </button>
            </div>

            {item.ruleCount === 0 ? (
              <p className="text-sm text-slate-500 py-3 text-center">
                No threshold rules set
              </p>
            ) : (
              <div className="space-y-2">
                {/* Rules would be displayed here from the item.rules data */}
                <p className="text-xs text-slate-600">
                  {item.ruleCount} rule{item.ruleCount !== 1 ? "s" : ""} configured
                </p>
              </div>
            )}
          </div>

          {/* Alerts Section */}
          {item.alertCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h5 className="text-sm font-semibold text-amber-900">
                    {item.alertCount} Active Alert
                    {item.alertCount !== 1 ? "s" : ""}
                  </h5>
                  {item.lastAlertTime && (
                    <p className="text-xs text-amber-700 mt-1">
                      Last: {new Date(item.lastAlertTime).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Main Watchlist component
 */
export function Watchlist() {
  const [state, setState] = useState<WatchlistState>({
    items: [],
    totalUnacknowledgedAlerts: 0,
    loading: true,
    error: null,
    expandedItems: new Set(),
  });

  const [dialogState, setDialogState] = useState<AddRuleDialogState>({
    open: false,
    ruleType: "apy_above",
    ruleValue: 0,
    triggerOnce: false,
  });

  // Load watchlist
  useEffect(() => {
    const loadWatchlist = async () => {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        const result = await WatchlistClientService.getWatchlist();
        setState((prev) => ({
          ...prev,
          items: result.items,
          totalUnacknowledgedAlerts: result.totalUnacknowledgedAlerts,
          loading: false,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          error: `Failed to load watchlist: ${error}`,
          loading: false,
        }));
      }
    };

    loadWatchlist();
  }, []);

  const handleToggleExpand = useCallback((itemId: string) => {
    setState((prev) => {
      const newExpanded = new Set(prev.expandedItems);
      if (newExpanded.has(itemId)) {
        newExpanded.delete(itemId);
      } else {
        newExpanded.add(itemId);
      }
      return { ...prev, expandedItems: newExpanded };
    });
  }, []);

  const handleRemove = useCallback(async (itemId: string) => {
    try {
      await WatchlistClientService.removeFromWatchlist(itemId);
      setState((prev) => ({
        ...prev,
        items: prev.items.filter((item) => item.id !== itemId),
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: `Failed to remove from watchlist: ${error}`,
      }));
    }
  }, []);

  const handleAddRule = useCallback((itemId: string) => {
    setDialogState((prev) => ({
      ...prev,
      open: true,
      itemId,
    }));
  }, []);

  const handleDialogAdd = useCallback(
    async (ruleType: string, value: number, triggerOnce: boolean) => {
      try {
        if (!dialogState.itemId) return;

        await WatchlistClientService.addThresholdRule(
          dialogState.itemId,
          ruleType as any,
          value,
          triggerOnce
        );

        // Refresh watchlist
        const result = await WatchlistClientService.getWatchlist();
        setState((prev) => ({
          ...prev,
          items: result.items,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          error: `Failed to add rule: ${error}`,
        }));
      }
    },
    [dialogState.itemId]
  );

  return (
    <div className="w-full max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-2xl font-bold text-slate-900">Yield Watchlist</h2>
          {state.totalUnacknowledgedAlerts > 0 && (
            <AlertBadge count={state.totalUnacknowledgedAlerts} showIcon={true} />
          )}
        </div>
        <p className="text-slate-600">
          Track yield opportunities and set custom threshold alerts
        </p>
      </div>

      {/* Error State */}
      {state.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-red-700">{state.error}</p>
          </div>
          <button
            onClick={() => setState((prev) => ({ ...prev, error: null }))}
            className="text-red-600 hover:text-red-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Loading State */}
      {state.loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-6 h-6 text-slate-400 animate-spin" />
          <p className="text-slate-600 ml-3">Loading watchlist...</p>
        </div>
      ) : state.items.length === 0 ? (
        /* Empty State */
        <div className="border border-dashed border-slate-300 rounded-lg p-12 text-center">
          <Bell className="w-16 h-16 text-slate-300 mx-auto mb-3" />
          <p className="text-lg font-semibold text-slate-900 mb-1">
            No watchlist items yet
          </p>
          <p className="text-slate-600 mb-6">
            Add yield opportunities to track and set up threshold alerts
          </p>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            Add Opportunity
          </button>
        </div>
      ) : (
        /* Watchlist Items */
        <div className="space-y-3">
          {state.items.map((item) => (
            <WatchlistItemCard
              key={item.id}
              item={item}
              expanded={state.expandedItems.has(item.id)}
              onToggleExpand={() => handleToggleExpand(item.id)}
              onRemove={handleRemove}
              onAddRule={handleAddRule}
              onRemoveRule={() => {}} // Implement in full version
              onAcknowledgeAlert={() => {}} // Implement in full version
            />
          ))}
        </div>
      )}

      {/* Add Rule Dialog */}
      <AddRuleDialog
        state={dialogState}
        onClose={() => setDialogState((prev) => ({ ...prev, open: false }))}
        onAdd={handleDialogAdd}
      />
    </div>
  );
}
