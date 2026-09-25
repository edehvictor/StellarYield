/**
 * Client-side service for fetching and polling rebalance events.
 * Provides utilities for both one-time fetch and real-time polling.
 */

import { apiUrl, apiFetch } from "../lib/api";
import type {
  RebalanceEvent,
  RebalanceFeedOptions,
  RebalanceFeedResponse,
} from "../../../shared/types/rebalanceEvent";

export class RebalanceFeedService {
  /**
   * Fetch rebalance events with optional filtering and pagination.
   */
  static async fetchRebalanceEvents(
    options: RebalanceFeedOptions = {}
  ): Promise<RebalanceFeedResponse> {
    const params = new URLSearchParams();

    if (options.vaultId) params.append("vaultId", options.vaultId);
    if (options.limit) params.append("limit", options.limit.toString());
    if (options.offset) params.append("offset", options.offset.toString());
    if (options.triggerReason) params.append("triggerReason", options.triggerReason);

    const response = await apiFetch(apiUrl(`/api/rebalances?${params}`));

    if (!response.ok) {
      throw new Error(
        `Failed to fetch rebalance events: ${response.status} ${response.statusText}`
      );
    }

    return response.json() as Promise<RebalanceFeedResponse>;
  }

  /**
   * Fetch recent rebalance events for a specific vault.
   * Optimized for real-time feed display.
   */
  static async fetchRecentRebalances(
    vaultId: string,
    limit: number = 10
  ): Promise<{
    vaultId: string;
    events: RebalanceEvent[];
    timestamp: string;
  }> {
    const response = await apiFetch(
      apiUrl(`/api/rebalances/${vaultId}/recent?limit=${limit}`)
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch recent rebalances: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  /**
   * Fetch rebalance statistics for a vault.
   */
  static async fetchRebalanceStats(vaultId: string): Promise<any> {
    const response = await apiFetch(apiUrl(`/api/rebalances/${vaultId}/stats`));

    if (!response.ok) {
      throw new Error(
        `Failed to fetch rebalance stats: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  /**
   * Poll for new rebalance events at a given interval.
   * Returns an unsubscribe function to stop polling.
   */
  static startPolling(
    vaultId: string,
    onUpdate: (events: RebalanceEvent[], hasError: boolean) => void,
    intervalMs: number = 30000 // Default: 30 seconds
  ): () => void {
    let isPolling = true;
    let lastTimestamp = new Date();

    const poll = async () => {
      try {
        const result = await this.fetchRecentRebalances(vaultId);
        
        // Filter to only new events since last poll
        const newEvents = result.events.filter(
          (e: RebalanceEvent) => new Date(e.timestamp) > lastTimestamp
        );

        if (newEvents.length > 0) {
          lastTimestamp = new Date();
          onUpdate(newEvents, false);
        }
      } catch (error) {
        console.error("Error polling for rebalance events:", error);
        onUpdate([], true);
      }
    };

    // Initial poll
    poll();

    // Set up interval
    const intervalId = setInterval(poll, intervalMs);

    // Return unsubscribe function
    return () => {
      isPolling = false;
      clearInterval(intervalId);
    };
  }

  /**
   * Set up Server-Sent Events for real-time rebalance updates.
   * Returns an unsubscribe function.
   */
  static subscribeToRebalanceUpdates(
    vaultId: string,
    onUpdate: (event: RebalanceEvent) => void,
    onError: (error: Error) => void
  ): () => void {
    const eventSource = new EventSource(
      apiUrl(`/api/rebalances/${vaultId}/stream`)
    );

    eventSource.addEventListener("rebalance", (event) => {
      try {
        const data = JSON.parse(event.data);
        onUpdate(data);
      } catch (error) {
        onError(new Error(`Failed to parse rebalance event: ${error}`));
      }
    });

    eventSource.addEventListener("error", () => {
      eventSource.close();
      onError(new Error("Connection to rebalance stream closed"));
    });

    // Return unsubscribe function
    return () => {
      eventSource.close();
    };
  }
}
