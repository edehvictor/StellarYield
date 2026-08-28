/**
 * Server-side service for managing yield opportunity watchlists and threshold rules.
 * Handles CRUD operations, threshold checking, and alert generation.
 */

import { PrismaClient } from "@prisma/client";
import { randomUUID as uuidv4 } from "crypto";
import type {
  YieldOpportunityWatchItem,
  WatchlistItem,
  WatchlistResponse,
  ThresholdRule,
  ThresholdCheckResult,
} from "../../../shared/types/watchlist";
import {
  checkThresholdTrigger,
  generateAlertMessage,
} from "../../../shared/types/watchlist";

const prisma = new PrismaClient();

export class WatchlistService {
  /**
   * Get user's watchlist with summary
   */
  static async getUserWatchlist(userId: string): Promise<WatchlistResponse> {
    const items = (await prisma.yieldOpportunityWatchItem.findMany({
      where: { userId, removedAt: null },
      orderBy: { updatedAt: "desc" },
    })) as YieldOpportunityWatchItem[];

    const unacknowledgedAlerts = items.reduce(
      (sum, item) => sum + item.triggeredAlerts.filter((a) => !a.acknowledged).length,
      0
    );

    const watchlistItems: WatchlistItem[] = items.map((item) => ({
      id: item.id,
      userId: item.userId,
      opportunityId: item.opportunityId,
      opportunityType: item.opportunityType,
      opportunityName: item.opportunityName,
      currentApy: item.currentApy,
      currentTvl: item.currentTvl,
      ruleCount: item.rules.length,
      alertCount: item.triggeredAlerts.length,
      lastAlertTime:
        item.triggeredAlerts.length > 0
          ? item.triggeredAlerts[0].timestamp
          : undefined,
    }));

    return {
      items: watchlistItems,
      total: items.length,
      totalUnacknowledgedAlerts: unacknowledgedAlerts,
    };
  }

  /**
   * Add an opportunity to user's watchlist
   */
  static async addToWatchlist(
    userId: string,
    opportunityId: string,
    opportunityType: string,
    opportunityName: string,
    currentApy: number,
    currentTvl: number
  ): Promise<YieldOpportunityWatchItem> {
    const item = await prisma.yieldOpportunityWatchItem.create({
      data: {
        id: uuidv4(),
        userId,
        opportunityId,
        opportunityType: opportunityType as any,
        opportunityName,
        currentApy,
        currentTvl,
        rules: [],
        triggeredAlerts: [],
      },
    });

    return item as YieldOpportunityWatchItem;
  }

  /**
   * Remove an opportunity from watchlist
   */
  static async removeFromWatchlist(
    userId: string,
    itemId: string
  ): Promise<YieldOpportunityWatchItem> {
    const item = await prisma.yieldOpportunityWatchItem.update({
      where: { id: itemId },
      data: { removedAt: new Date() },
    });

    return item as YieldOpportunityWatchItem;
  }

  /**
   * Add a threshold rule to a watchlist item
   */
  static async addThresholdRule(
    userId: string,
    itemId: string,
    ruleType: string,
    ruleValue: number,
    triggerOnce: boolean = false
  ): Promise<ThresholdRule> {
    const item = (await prisma.yieldOpportunityWatchItem.findUnique({
      where: { id: itemId },
    })) as YieldOpportunityWatchItem | null;

    if (!item || item.userId !== userId || item.removedAt) {
      throw new Error("Watchlist item not found");
    }

    const newRule: ThresholdRule = {
      id: uuidv4(),
      type: ruleType as any,
      value: ruleValue,
      triggerOnce,
    };

    await prisma.yieldOpportunityWatchItem.update({
      where: { id: itemId },
      data: {
        rules: [...item.rules, newRule],
        updatedAt: new Date(),
      },
    });

    return newRule;
  }

  /**
   * Remove a threshold rule from a watchlist item
   */
  static async removeThresholdRule(
    userId: string,
    itemId: string,
    ruleId: string
  ): Promise<void> {
    const item = (await prisma.yieldOpportunityWatchItem.findUnique({
      where: { id: itemId },
    })) as YieldOpportunityWatchItem | null;

    if (!item || item.userId !== userId || item.removedAt) {
      throw new Error("Watchlist item not found");
    }

    await prisma.yieldOpportunityWatchItem.update({
      where: { id: itemId },
      data: {
        rules: item.rules.filter((r) => r.id !== ruleId),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Check threshold rules for a watchlist item and trigger alerts if needed
   */
  static async checkThresholdsAndTriggerAlerts(
    itemId: string,
    currentApy: number,
    currentTvl: number,
    spreadChange: number = 0
  ): Promise<ThresholdCheckResult[]> {
    const item = (await prisma.yieldOpportunityWatchItem.findUnique({
      where: { id: itemId },
    })) as YieldOpportunityWatchItem | null;

    if (!item) {
      throw new Error("Watchlist item not found");
    }

    const results: ThresholdCheckResult[] = [];

    for (const rule of item.rules) {
      const triggered = checkThresholdTrigger(
        rule,
        currentApy,
        currentTvl,
        spreadChange
      );

      const previousAlert = item.triggeredAlerts.find((a) => a.ruleId === rule.id);
      const previousTriggered = !!previousAlert && !previousAlert.acknowledged;

      if (triggered && (!previousTriggered || !rule.triggerOnce)) {
        const message = generateAlertMessage(
          item.opportunityName,
          rule,
          currentApy,
          currentTvl,
          spreadChange
        );

        // Add or update alert
        const newAlert = {
          ruleId: rule.id,
          message,
          timestamp: new Date(),
          acknowledged: false,
        };

        let updatedAlerts = item.triggeredAlerts;

        // If triggerOnce, only create alert once
        if (rule.triggerOnce && previousAlert) {
          // Do nothing - alert already triggered
          updatedAlerts = item.triggeredAlerts;
        } else {
          // Add new alert to the beginning of the list
          updatedAlerts = [newAlert, ...item.triggeredAlerts];
        }

        await prisma.yieldOpportunityWatchItem.update({
          where: { id: itemId },
          data: {
            currentApy,
            currentTvl,
            lastMetricUpdate: new Date(),
            triggeredAlerts: updatedAlerts,
            updatedAt: new Date(),
          },
        });

        results.push({
          itemId,
          ruleId: rule.id,
          triggered: true,
          message,
          previousTriggered,
        });
      } else if (!triggered && previousTriggered) {
        // Rule is no longer triggered, acknowledge the previous alert
        const updatedAlerts = item.triggeredAlerts.map((a) =>
          a.ruleId === rule.id ? { ...a, acknowledged: true } : a
        );

        await prisma.yieldOpportunityWatchItem.update({
          where: { id: itemId },
          data: {
            currentApy,
            currentTvl,
            lastMetricUpdate: new Date(),
            triggeredAlerts: updatedAlerts,
            updatedAt: new Date(),
          },
        });

        results.push({
          itemId,
          ruleId: rule.id,
          triggered: false,
          message: `Alert acknowledged: condition no longer met`,
        });
      } else {
        // Update metrics even if threshold not triggered
        await prisma.yieldOpportunityWatchItem.update({
          where: { id: itemId },
          data: {
            currentApy,
            currentTvl,
            lastMetricUpdate: new Date(),
            updatedAt: new Date(),
          },
        });
      }
    }

    return results;
  }

  /**
   * Acknowledge an alert
   */
  static async acknowledgeAlert(
    userId: string,
    itemId: string,
    ruleId: string
  ): Promise<void> {
    const item = (await prisma.yieldOpportunityWatchItem.findUnique({
      where: { id: itemId },
    })) as YieldOpportunityWatchItem | null;

    if (!item || item.userId !== userId || item.removedAt) {
      throw new Error("Watchlist item not found");
    }

    const updatedAlerts = item.triggeredAlerts.map((a) =>
      a.ruleId === ruleId ? { ...a, acknowledged: true } : a
    );

    await prisma.yieldOpportunityWatchItem.update({
      where: { id: itemId },
      data: {
        triggeredAlerts: updatedAlerts,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Get all unacknowledged alerts for a user
   */
  static async getUserAlerts(userId: string): Promise<
    Array<{
      itemId: string;
      opportunityName: string;
      alerts: Array<{
        ruleId: string;
        message: string;
        timestamp: Date;
      }>;
    }>
  > {
    const items = (await prisma.yieldOpportunityWatchItem.findMany({
      where: { userId, removedAt: null },
    })) as YieldOpportunityWatchItem[];

    return items
      .filter((item) => item.triggeredAlerts.some((a) => !a.acknowledged))
      .map((item) => ({
        itemId: item.id,
        opportunityName: item.opportunityName,
        alerts: item.triggeredAlerts
          .filter((a) => !a.acknowledged)
          .map((a) => ({
            ruleId: a.ruleId,
            message: a.message,
            timestamp: a.timestamp,
          })),
      }));
  }

  /**
   * Batch check thresholds for multiple items
   */
  static async batchCheckThresholds(
    items: Array<{
      itemId: string;
      currentApy: number;
      currentTvl: number;
      spreadChange?: number;
    }>
  ): Promise<ThresholdCheckResult[]> {
    const allResults: ThresholdCheckResult[] = [];

    for (const item of items) {
      const results = await this.checkThresholdsAndTriggerAlerts(
        item.itemId,
        item.currentApy,
        item.currentTvl,
        item.spreadChange || 0
      );
      allResults.push(...results);
    }

    return allResults;
  }
}
