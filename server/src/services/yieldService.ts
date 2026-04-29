import NodeCache from "node-cache";
import { PROTOCOLS } from "../config/protocols";
import { normalizeYields } from "../utils/yieldNormalization";
import { fetchNetworkSnapshot } from "./stellarNetworkService";
import { freezeService } from "./freezeService";
import type { NormalizedYield, RawProtocolYield } from "../types/yields";

const cache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});

const CACHE_KEY = "current-yields";
const LAST_GOOD_CACHE_KEY = "current-yields:last-good";
export const CURRENT_YIELDS_TTL_SECONDS = 300;
export const FALLBACK_TTL_SECONDS = 120;

export type YieldCacheStatus = "HIT" | "MISS";

export async function getYieldDataWithCacheStatus(): Promise<{
  data: NormalizedYield[];
  cacheStatus: YieldCacheStatus;
}> {
  const cached = cache.get<NormalizedYield[]>(CACHE_KEY);
  if (cached) return { data: cached, cacheStatus: "HIT" };
  return { data: await getYieldData(), cacheStatus: "MISS" };
}

function buildProtocolSnapshot(
  config: (typeof PROTOCOLS)[number],
  ledgerSequence: number,
  fetchedAt: string,
  network: "mainnet" | "testnet",
): RawProtocolYield {
  const apyVarianceBps = ledgerSequence % 25;
  const tvlVarianceUsd = (ledgerSequence % 10) * 12_500;

  return {
    protocolName: config.protocolName,
    protocolType: config.protocolType,
    apyBps: config.baseApyBps + apyVarianceBps,
    tvlUsd: config.baseTvlUsd + tvlVarianceUsd,
    volatilityPct: config.volatilityPct,
    protocolAgeDays: config.protocolAgeDays,
    network,
    source: config.source,
    fetchedAt,
    liquidityUsd: config.liquidityUsd,
    rebalancingBehavior: config.rebalancingBehavior,
    managementFeeBps: config.managementFeeBps,
    performanceFeeBps: config.performanceFeeBps,
    capitalEfficiencyPct: config.capitalEfficiencyPct,
    rewards: config.rewardStreams,
    attribution: {
      baseYield: config.baseApyBps / 100 * 0.8,
      incentives: config.baseApyBps / 100 * 0.1,
      compounding: config.baseApyBps / 100 * 0.05,
      tacticalRotation: config.baseApyBps / 100 * 0.05,
    },
  };
}

export async function getYieldData(): Promise<NormalizedYield[]> {
  if (freezeService.isFrozen()) {
    return [];
  }

  const cached = cache.get<NormalizedYield[]>(CACHE_KEY);

  if (cached) {
    return cached;
  }

  try {
    const snapshot = await fetchNetworkSnapshot();
    const rawYields = PROTOCOLS.map((protocol) =>
      buildProtocolSnapshot(
        protocol,
        snapshot.ledgerSequence,
        snapshot.closedAt,
        snapshot.network,
      ),
    );

    const normalized = normalizeYields(rawYields);
    cache.set(CACHE_KEY, normalized, CURRENT_YIELDS_TTL_SECONDS);
    cache.set(LAST_GOOD_CACHE_KEY, normalized, CURRENT_YIELDS_TTL_SECONDS * 6);
    return normalized;
  } catch (error) {
    console.error("Yield fetch failed.", error);

    const lastGood = cache.get<NormalizedYield[]>(LAST_GOOD_CACHE_KEY);
    if (lastGood) {
      cache.set(CACHE_KEY, lastGood, Math.min(60, CURRENT_YIELDS_TTL_SECONDS));
      return lastGood;
    }

    const fallback = normalizeYields(
      PROTOCOLS.map((protocol) => ({
        protocolName: protocol.protocolName,
        protocolType: protocol.protocolType,
        apyBps: protocol.baseApyBps,
        tvlUsd: protocol.baseTvlUsd,
        volatilityPct: protocol.volatilityPct,
        protocolAgeDays: protocol.protocolAgeDays,
        network: "mainnet",
        source: protocol.source,
        fetchedAt: new Date().toISOString(),
        liquidityUsd: protocol.liquidityUsd,
        rebalancingBehavior: protocol.rebalancingBehavior,
        managementFeeBps: protocol.managementFeeBps,
        performanceFeeBps: protocol.performanceFeeBps,
        capitalEfficiencyPct: protocol.capitalEfficiencyPct,
        rewards: protocol.rewardStreams,
      })),
    );

    cache.set(CACHE_KEY, fallback, FALLBACK_TTL_SECONDS);
    return fallback;
  }
}
