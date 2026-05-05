import NodeCache from "node-cache";
import { connectToDatabase } from "../db/database";
import {
  VaultRebalanceEventModel,
  type VaultRebalanceEvent,
  type AllocationBreakdown,
} from "../models/VaultRebalanceEvent";

const cache = new NodeCache({
  stdTTL: 60,
  checkperiod: process.env.NODE_ENV === "test" ? 0 : 30,
});
const REBALANCE_FEED_CACHE_KEY = "rebalance-feed";
const LATEST_REBALANCE_CACHE_KEY = "rebalance-latest";

export interface RebalanceFeedEntry {
  id: string;
  vaultId: string;
  vaultName: string;
  timestamp: string;
  triggerReason: string;
  expectedOutcome: string;
  riskNote: string;
  beforeAllocations: AllocationBreakdown[];
  afterAllocations: AllocationBreakdown[];
  status: "pending" | "completed" | "failed";
  changes: {
    assetId: string;
    assetName: string;
    beforeWeight: number;
    afterWeight: number;
    weightChange: number;
    beforeValue: number;
    afterValue: number;
    valueChange: number;
  }[];
}

function computeChanges(
  before: AllocationBreakdown[],
  after: AllocationBreakdown[],
): RebalanceFeedEntry["changes"] {
  const beforeMap = new Map(before.map((a) => [a.assetId, a]));
  const afterMap = new Map(after.map((a) => [a.assetId, a]));
  const allAssetIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  return Array.from(allAssetIds).map((assetId) => {
    const beforeAsset = beforeMap.get(assetId) || {
      assetId,
      assetName: "",
      weight: 0,
      value: 0,
    };
    const afterAsset = afterMap.get(assetId) || {
      assetId,
      assetName: "",
      weight: 0,
      value: 0,
    };

    return {
      assetId,
      assetName: beforeAsset.assetName || afterAsset.assetName,
      beforeWeight: beforeAsset.weight,
      afterWeight: afterAsset.weight,
      weightChange: afterAsset.weight - beforeAsset.weight,
      beforeValue: beforeAsset.value,
      afterValue: afterAsset.value,
      valueChange: afterAsset.value - beforeAsset.value,
    };
  });
}

export async function getRebalanceFeed(
  vaultId?: string,
  limit = 20,
  beforeTimestamp?: string,
): Promise<RebalanceFeedEntry[]> {
  const db = await connectToDatabase();
  if (!db) {
    return [];
  }

  const cacheKey = `${REBALANCE_FEED_CACHE_KEY}:${vaultId || "all"}:${limit}:${beforeTimestamp || "none"}`;
  const cached = cache.get<RebalanceFeedEntry[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const query: Record<string, unknown> = {};
  if (vaultId) {
    query.vaultId = vaultId;
  }
  if (beforeTimestamp) {
    query.timestamp = { $lt: new Date(beforeTimestamp) };
  }

  const events = await VaultRebalanceEventModel.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();

  const feed: RebalanceFeedEntry[] = events.map((event) => ({
    id: event._id.toString(),
    vaultId: event.vaultId,
    vaultName: event.vaultName,
    timestamp: event.timestamp.toISOString(),
    triggerReason: event.triggerReason,
    expectedOutcome: event.expectedOutcome,
    riskNote: event.riskNote,
    beforeAllocations: event.beforeAllocations,
    afterAllocations: event.afterAllocations,
    status: event.status,
    changes: computeChanges(event.beforeAllocations, event.afterAllocations),
  }));

  cache.set(cacheKey, feed, 60);

  return feed;
}

export async function getLatestRebalance(
  vaultId: string,
): Promise<RebalanceFeedEntry | null> {
  const db = await connectToDatabase();
  if (!db) {
    return null;
  }

  const cacheKey = `${LATEST_REBALANCE_CACHE_KEY}:${vaultId}`;
  const cached = cache.get<RebalanceFeedEntry>(cacheKey);
  if (cached) {
    return cached;
  }

  const event = await VaultRebalanceEventModel.findOne({ vaultId })
    .sort({ timestamp: -1 })
    .lean();

  if (!event) {
    return null;
  }

  const feed: RebalanceFeedEntry = {
    id: event._id.toString(),
    vaultId: event.vaultId,
    vaultName: event.vaultName,
    timestamp: event.timestamp.toISOString(),
    triggerReason: event.triggerReason,
    expectedOutcome: event.expectedOutcome,
    riskNote: event.riskNote,
    beforeAllocations: event.beforeAllocations,
    afterAllocations: event.afterAllocations,
    status: event.status,
    changes: computeChanges(event.beforeAllocations, event.afterAllocations),
  };

  cache.set(cacheKey, feed, 60);

  return feed;
}

export async function recordRebalanceEvent(
  vaultId: string,
  vaultName: string,
  triggerReason: string,
  expectedOutcome: string,
  riskNote: string,
  beforeAllocations: AllocationBreakdown[],
  afterAllocations: AllocationBreakdown[],
  status: VaultRebalanceEvent["status"] = "completed",
): Promise<RebalanceFeedEntry> {
  const db = await connectToDatabase();
  if (!db) {
    throw new Error("Database not available");
  }

  const event = await VaultRebalanceEventModel.create({
    vaultId,
    vaultName,
    timestamp: new Date(),
    triggerReason,
    expectedOutcome,
    riskNote,
    beforeAllocations,
    afterAllocations,
    status,
  });

  cache.del(REBALANCE_FEED_CACHE_KEY);
  cache.del(`${LATEST_REBALANCE_CACHE_KEY}:${vaultId}`);

  return {
    id: event._id.toString(),
    vaultId: event.vaultId,
    vaultName: event.vaultName,
    timestamp: event.timestamp.toISOString(),
    triggerReason: event.triggerReason,
    expectedOutcome: event.expectedOutcome,
    riskNote: event.riskNote,
    beforeAllocations: event.beforeAllocations,
    afterAllocations: event.afterAllocations,
    status: event.status,
    changes: computeChanges(event.beforeAllocations, event.afterAllocations),
  };
}

export async function getRebalanceById(
  eventId: string,
): Promise<RebalanceFeedEntry | null> {
  const db = await connectToDatabase();
  if (!db) {
    return null;
  }

  const event = await VaultRebalanceEventModel.findById(eventId).lean();

  if (!event) {
    return null;
  }

  return {
    id: event._id.toString(),
    vaultId: event.vaultId,
    vaultName: event.vaultName,
    timestamp: event.timestamp.toISOString(),
    triggerReason: event.triggerReason,
    expectedOutcome: event.expectedOutcome,
    riskNote: event.riskNote,
    beforeAllocations: event.beforeAllocations,
    afterAllocations: event.afterAllocations,
    status: event.status,
    changes: computeChanges(event.beforeAllocations, event.afterAllocations),
  };
}

export { computeChanges };