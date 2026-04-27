import NodeCache from "node-cache";
import { connectToDatabase } from "../db/database";
import { WatchlistRuleModel, type WatchlistRule, type WatchlistCondition } from "../models/WatchlistRule";
import { getYieldData } from "./yieldService";

const cache = new NodeCache({
  stdTTL: 60,
  checkperiod: process.env.NODE_ENV === "test" ? 0 : 30,
});

const WATCHLIST_CACHE_PREFIX = "watchlist:user:";
const RULE_TRIGGER_PREFIX = "watchlist:rule-triggered:";

export interface WatchlistRuleInput {
  userId: string;
  targetType: "protocol" | "pool" | "strategy";
  targetId: string;
  targetName: string;
  conditions: Omit<WatchlistCondition, "cooldownMinutes">[];
  notificationChannels: readonly ("email" | "webhook" | "push")[];
}

export interface RuleEvaluationResult {
  ruleId: string;
  triggered: boolean;
  metric: string;
  currentValue: number;
  threshold: number;
  message: string;
}

function validateRuleInput(
  input: WatchlistRuleInput,
): string[] {
  const errors: string[] = [];

  if (!input.userId || input.userId.length < 5) {
    errors.push("Invalid userId");
  }

  if (!["protocol", "pool", "strategy"].includes(input.targetType)) {
    errors.push("Invalid targetType");
  }

  if (!input.targetId || input.targetId.length < 2) {
    errors.push("Invalid targetId");
  }

  if (!input.targetName || input.targetName.length < 1) {
    errors.push("Invalid targetName");
  }

  if (!input.conditions || input.conditions.length === 0) {
    errors.push("At least one condition is required");
  }

  for (const condition of input.conditions) {
    if (!["apy", "tvl", "spread"].includes(condition.metric)) {
      errors.push(`Invalid condition metric: ${condition.metric}`);
    }
    if (!["above", "below", "change_above"].includes(condition.operator)) {
      errors.push(`Invalid condition operator: ${condition.operator}`);
    }
    if (typeof condition.value !== "number" || condition.value < 0) {
      errors.push(`Invalid condition value: ${condition.value}`);
    }
  }

  if (!input.notificationChannels || input.notificationChannels.length === 0) {
    errors.push("At least one notification channel is required");
  }

  return errors;
}

export { validateRuleInput };

export async function createWatchlistRule(
  input: WatchlistRuleInput,
): Promise<WatchlistRule> {
  const errors = validateRuleInput(input);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(", ")}`);
  }

  const db = await connectToDatabase();
  if (!db) {
    throw new Error("Database not available");
  }

  const conditions: WatchlistCondition[] = input.conditions.map((c) => ({
    ...c,
    cooldownMinutes: 60,
  }));

  const rule = await WatchlistRuleModel.create({
    userId: input.userId,
    targetType: input.targetType,
    targetId: input.targetId,
    targetName: input.targetName,
    conditions,
    notificationChannels: input.notificationChannels,
    status: "active",
  });

  cache.del(`${WATCHLIST_CACHE_PREFIX}${input.userId}`);

  return rule;
}

export async function getUserWatchlist(userId: string): Promise<WatchlistRule[]> {
  const db = await connectToDatabase();
  if (!db) {
    return [];
  }

  const cached = cache.get<WatchlistRule[]>(`${WATCHLIST_CACHE_PREFIX}${userId}`);
  if (cached) {
    return cached;
  }

  const rules = await WatchlistRuleModel.find({
    userId,
    status: { $ne: "deleted" },
  }).sort({ createdAt: -1 });

  cache.set(`${WATCHLIST_CACHE_PREFIX}${userId}`, rules, 60);

  return rules;
}

export async function updateWatchlistRule(
  ruleId: string,
  updates: Partial<Pick<WatchlistRule, "status" | "conditions" | "notificationChannels">>,
): Promise<WatchlistRule | null> {
  const db = await connectToDatabase();
  if (!db) {
    throw new Error("Database not available");
  }

  if (updates.conditions) {
    const errors = updates.conditions.map((c) => {
      if (!["apy", "tvl", "spread"].includes(c.metric)) return `Invalid metric: ${c.metric}`;
      if (!["above", "below", "change_above"].includes(c.operator)) return `Invalid operator: ${c.operator}`;
      if (typeof c.value !== "number" || c.value < 0) return `Invalid value: ${c.value}`;
      return null;
    }).filter(Boolean);

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(", ")}`);
    }
  }

  const rule = await WatchlistRuleModel.findByIdAndUpdate(
    ruleId,
    { ...updates, updatedAt: new Date() },
    { new: true },
  );

  if (rule) {
    cache.del(`${WATCHLIST_CACHE_PREFIX}${rule.userId}`);
  }

  return rule;
}

export async function deleteWatchlistRule(
  ruleId: string,
): Promise<boolean> {
  const db = await connectToDatabase();
  if (!db) {
    throw new Error("Database not available");
  }

  const rule = await WatchlistRuleModel.findByIdAndUpdate(
    ruleId,
    { status: "deleted", updatedAt: new Date() },
  );

  if (rule) {
    cache.del(`${WATCHLIST_CACHE_PREFIX}${rule.userId}`);
    return true;
  }

  return false;
}

async function getCurrentMetrics(targetId: string, targetType: "protocol" | "pool" | "strategy"): Promise<{
  apy: number;
  tvl: number;
  spread: number;
} | null> {
  if (targetType === "protocol") {
    const yields = await getYieldData();
    const target = yields.find((y) => y.source === targetId || y.protocolName.toLowerCase() === targetId.toLowerCase());
    if (target) {
      return {
        apy: target.apy,
        tvl: target.tvl,
        spread: Math.max(0, target.apy - 5),
      };
    }
  }
  return null;
}

export function checkCondition(
  currentValue: number,
  previousValue: number,
  condition: WatchlistCondition,
): boolean {
  switch (condition.operator) {
    case "above":
      return currentValue > condition.value;
    case "below":
      return currentValue < condition.value;
    case "change_above":
      const changePct = previousValue > 0
        ? Math.abs((currentValue - previousValue) / previousValue) * 100
        : 0;
      return changePct >= condition.value;
    default:
      return false;
  }
}

export async function evaluateWatchlistRules(
  userId?: string,
): Promise<RuleEvaluationResult[]> {
  const db = await connectToDatabase();
  if (!db) {
    return [];
  }

  const query: Record<string, unknown> = { status: "active" };
  if (userId) {
    query.userId = userId;
  }

  const rules = await WatchlistRuleModel.find(query);
  const results: RuleEvaluationResult[] = [];

  for (const rule of rules) {
    const metrics = await getCurrentMetrics(rule.targetId, rule.targetType);
    if (!metrics) continue;

    for (const condition of rule.conditions) {
      const currentValue = metrics[condition.metric as keyof typeof metrics] ?? 0;
      const cooldownKey = `${RULE_TRIGGER_PREFIX}${rule._id}:${condition.metric}`;
      const lastTriggered = cache.get<Date>(cooldownKey);

      if (lastTriggered) {
        const cooldownMs = condition.cooldownMinutes * 60 * 1000;
        if (Date.now() - lastTriggered.getTime() < cooldownMs) {
          continue;
        }
      }

      const triggered = checkCondition(currentValue, 0, condition);

      if (triggered) {
        const result: RuleEvaluationResult = {
          ruleId: rule._id.toString(),
          triggered: true,
          metric: condition.metric,
          currentValue,
          threshold: condition.value,
          message: `${rule.targetName} ${condition.operator === "above" ? "exceeded" : condition.operator === "below" ? "fell below" : "changed by more than"} ${condition.value}${condition.metric === "apy" ? "%" : condition.metric === "tvl" ? "$" : "%"}`,
        };

        results.push(result);

        await sendNotification(
          rule.userId,
          `Yield Alert: ${rule.targetName}`,
          result.message,
          rule.notificationChannels,
        );

        cache.set(cooldownKey, new Date());

        await WatchlistRuleModel.findByIdAndUpdate(rule._id, {
          lastTriggeredAt: new Date(),
          status: "triggered",
        });
      }
    }
  }

  return results;
}

async function sendNotification(
  userId: string,
  title: string,
  message: string,
  channels: readonly ("email" | "webhook" | "push")[],
): Promise<void> {
  console.log(`[Watchlist Notification] User: ${userId}, Title: ${title}, Message: ${message}, Channels: ${channels.join(", ")}`);
}