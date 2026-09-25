/**
 * Server-side service for tracking and serving rebalance events.
 * Provides data about vault rebalancing operations with before/after snapshots,
 * trigger reasons, expected outcomes, and risk notes.
 */

import { PrismaClient } from "@prisma/client";
import type {
  RebalanceEvent,
  RebalanceFeedOptions,
  RebalanceFeedResponse,
  RebalanceTriggerReason,
  RebalanceAllocation,
} from "../../shared/types/rebalanceEvent";

const prisma = new PrismaClient();

export class RebalanceEventService {
  /**
   * Fetch rebalance events for a vault or across all vaults.
   * Supports pagination and filtering by trigger reason.
   */
  static async getRebalanceEvents(
    options: RebalanceFeedOptions = {}
  ): Promise<RebalanceFeedResponse> {
    const limit = Math.min(options.limit || 20, 100); // Cap at 100
    const offset = options.offset || 0;

    const where: any = {};
    if (options.vaultId) where.vaultId = options.vaultId;
    if (options.triggerReason) where.triggerReason = options.triggerReason;

    const [events, total] = await Promise.all([
      prisma.rebalanceEvent.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.rebalanceEvent.count({ where }),
    ]);

    return {
      events: events as RebalanceEvent[],
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Create a new rebalance event record.
   */
  static async createRebalanceEvent(
    data: Omit<RebalanceEvent, "id">
  ): Promise<RebalanceEvent> {
    const event = await prisma.rebalanceEvent.create({
      data: {
        ...data,
        timestamp: new Date(data.timestamp),
      },
    });

    return event as RebalanceEvent;
  }

  /**
   * Update an existing rebalance event (e.g., to mark as completed).
   */
  static async updateRebalanceEvent(
    eventId: string,
    updates: Partial<RebalanceEvent>
  ): Promise<RebalanceEvent> {
    const event = await prisma.rebalanceEvent.update({
      where: { id: eventId },
      data: updates,
    });

    return event as RebalanceEvent;
  }

  /**
   * Get recent rebalance events for a specific vault (for real-time feed).
   */
  static async getRecentRebalances(
    vaultId: string,
    limit: number = 10
  ): Promise<RebalanceEvent[]> {
    return (await prisma.rebalanceEvent.findMany({
      where: { vaultId },
      orderBy: { timestamp: "desc" },
      take: limit,
    })) as RebalanceEvent[];
  }

  /**
   * Get rebalance statistics for a vault.
   */
  static async getRebalanceStats(vaultId: string) {
    const events = (await prisma.rebalanceEvent.findMany({
      where: { vaultId },
      orderBy: { timestamp: "desc" },
      take: 100, // Last 100 rebalances
    })) as RebalanceEvent[];

    if (events.length === 0) {
      return {
        totalRebalances: 0,
        averageApyImprovement: 0,
        averageRiskScoreChange: 0,
        mostCommonTrigger: null,
      };
    }

    const completedEvents = events.filter((e) => e.executionStatus === "completed");

    const totalApyChange = completedEvents.reduce(
      (sum, e) => sum + e.expectedOutcome.apyChangePercent,
      0
    );

    const totalRiskChange = completedEvents.reduce(
      (sum, e) =>
        sum +
        (e.triggerDetails.riskScoreChange
          ? e.triggerDetails.riskScoreChange.after - e.triggerDetails.riskScoreChange.before
          : 0),
      0
    );

    const triggerReasons = events.reduce(
      (acc, e) => {
        acc[e.triggerReason] = (acc[e.triggerReason] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const mostCommonTrigger = Object.entries(triggerReasons).sort(
      (a, b) => b[1] - a[1]
    )[0]?.[0];

    return {
      totalRebalances: events.length,
      completedRebalances: completedEvents.length,
      averageApyImprovement: totalApyChange / events.length,
      averageRiskScoreChange: totalRiskChange / completedEvents.length,
      mostCommonTrigger: mostCommonTrigger || null,
      triggerDistribution: triggerReasons,
    };
  }

  /**
   * Record allocation changes in a rebalance event.
   * Calculates percentage changes and validates data.
   */
  static calculateAllocationChanges(
    before: RebalanceAllocation[],
    after: RebalanceAllocation[]
  ): {
    changes: Record<string, { before: number; after: number; delta: number }>;
    totalDrift: number;
  } {
    const beforeMap = new Map(before.map((a) => [a.protocol, a.percentage]));
    const afterMap = new Map(after.map((a) => [a.protocol, a.percentage]));

    const changes: Record<string, { before: number; after: number; delta: number }> = {};
    let totalDrift = 0;

    const allProtocols = new Set([...beforeMap.keys(), ...afterMap.keys()]);

    allProtocols.forEach((protocol) => {
      const beforePct = beforeMap.get(protocol) || 0;
      const afterPct = afterMap.get(protocol) || 0;
      const delta = afterPct - beforePct;

      changes[protocol] = { before: beforePct, after: afterPct, delta };
      totalDrift += Math.abs(delta);
    });

    return { changes, totalDrift };
  }
}
