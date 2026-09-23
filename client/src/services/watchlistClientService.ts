/**
 * Client-side service for managing yield opportunity watchlist.
 * Handles API communication for CRUD operations and threshold checks.
 *
 * Every call is scoped to a wallet address (sent as the x-wallet-address
 * header, matching server/src/routes/watchlist.ts's getWalletAddress
 * convention) so watchlist data never leaks across wallets on reconnect
 * or wallet switch (#1173).
 */

import { apiUrl, apiFetch } from "../lib/api";
import type {
  YieldOpportunityWatchItem,
  WatchlistResponse,
  ThresholdRule,
  ThresholdCheckResult,
} from "../../../shared/types/watchlist";

function walletHeaders(walletAddress: string): HeadersInit {
  return { "x-wallet-address": walletAddress };
}

export class WatchlistClientService {
  private static readonly baseUrl = "/api/watchlist";

  /**
   * Get user's watchlist with summary
   */
  static async getWatchlist(walletAddress: string): Promise<WatchlistResponse> {
    const response = await apiFetch(apiUrl(this.baseUrl), {
      headers: walletHeaders(walletAddress),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch watchlist: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get all unacknowledged alerts
   */
  static async getAlerts(walletAddress: string): Promise<{
    alerts: Array<{
      itemId: string;
      opportunityName: string;
      alerts: Array<{
        ruleId: string;
        message: string;
        timestamp: string;
      }>;
    }>;
    total: number;
  }> {
    const response = await apiFetch(apiUrl(`${this.baseUrl}/alerts`), {
      headers: walletHeaders(walletAddress),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch alerts: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Add an opportunity to watchlist
   */
  static async addToWatchlist(
    walletAddress: string,
    opportunityId: string,
    opportunityType: "protocol" | "pool" | "strategy",
    opportunityName: string,
    currentApy: number,
    currentTvl: number
  ): Promise<YieldOpportunityWatchItem> {
    const response = await apiFetch(apiUrl(this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...walletHeaders(walletAddress) },
      body: JSON.stringify({
        opportunityId,
        opportunityType,
        opportunityName,
        currentApy,
        currentTvl,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add to watchlist: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Remove an opportunity from watchlist
   */
  static async removeFromWatchlist(walletAddress: string, itemId: string): Promise<void> {
    const response = await apiFetch(apiUrl(`${this.baseUrl}/${itemId}`), {
      method: "DELETE",
      headers: walletHeaders(walletAddress),
    });

    if (!response.ok) {
      throw new Error(`Failed to remove from watchlist: ${response.statusText}`);
    }
  }

  /**
   * Add a threshold rule to a watchlist item
   */
  static async addThresholdRule(
    walletAddress: string,
    itemId: string,
    type:
      | "apy_above"
      | "apy_below"
      | "tvl_above"
      | "tvl_below"
      | "spread_change_above",
    value: number,
    triggerOnce?: boolean
  ): Promise<ThresholdRule> {
    const response = await apiFetch(apiUrl(`${this.baseUrl}/${itemId}/rules`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...walletHeaders(walletAddress) },
      body: JSON.stringify({ type, value, triggerOnce }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add threshold rule: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Remove a threshold rule
   */
  static async removeThresholdRule(
    walletAddress: string,
    itemId: string,
    ruleId: string
  ): Promise<void> {
    const response = await apiFetch(
      apiUrl(`${this.baseUrl}/${itemId}/rules/${ruleId}`),
      {
        method: "DELETE",
        headers: walletHeaders(walletAddress),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to remove threshold rule: ${response.statusText}`);
    }
  }

  /**
   * Check thresholds for a specific item.
   * Not wallet-scoped server-side (thresholds are keyed by itemId alone),
   * so no wallet header is required here.
   */
  static async checkThresholds(
    itemId: string,
    currentApy: number,
    currentTvl: number,
    spreadChange?: number
  ): Promise<{ checks: ThresholdCheckResult[]; triggeredCount: number }> {
    const response = await apiFetch(apiUrl(`${this.baseUrl}/${itemId}/check`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentApy,
        currentTvl,
        spreadChange,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to check thresholds: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Acknowledge an alert
   */
  static async acknowledgeAlert(
    walletAddress: string,
    itemId: string,
    ruleId: string
  ): Promise<void> {
    const response = await apiFetch(
      apiUrl(`${this.baseUrl}/${itemId}/alerts/${ruleId}/acknowledge`),
      {
        method: "POST",
        headers: walletHeaders(walletAddress),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to acknowledge alert: ${response.statusText}`);
    }
  }

  /**
   * Batch check thresholds for multiple items.
   * Not wallet-scoped server-side — see checkThresholds.
   */
  static async batchCheckThresholds(
    items: Array<{
      itemId: string;
      currentApy: number;
      currentTvl: number;
      spreadChange?: number;
    }>
  ): Promise<{ checked: number; triggeredCount: number; results: ThresholdCheckResult[] }> {
    const response = await apiFetch(apiUrl(`${this.baseUrl}/batch/check`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });

    if (!response.ok) {
      throw new Error(`Failed to batch check thresholds: ${response.statusText}`);
    }

    return response.json();
  }
}
