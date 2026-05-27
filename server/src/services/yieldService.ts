import computeConfidence from './confidenceService';

type ProviderReading = { provider: string; apy?: number; weight?: number };

export function aggregateApy(readings: ProviderReading[]) {
  const reasons: string[] = [];
  if (!readings || readings.length === 0) {
    reasons.push('no_readings');
    return { consensusApy: null, confidence: { score: 0, reasons } };
  }

  // Step 1: normalize weights and filter missing
  const available = readings.map((r) => ({ ...r }));
  const present = available.filter((r) => typeof r.apy === 'number');
  if (present.length === 0) {
    reasons.push('missing_all_apy');
    return { consensusApy: null, confidence: { score: 0, reasons } };
  }

  const totalRaw = present.reduce((s, p) => s + (p.weight ?? 1), 0);
  present.forEach((p) => (p.weight = (p.weight ?? 1) / Math.max(1e-12, totalRaw)));

  // Step 2: detect outliers using median absolute deviation (robust)
  const apys = present.map((p) => p.apy!);
  const median = apys.slice().sort((a, b) => a - b)[Math.floor(apys.length / 2)];
  const deviations = apys.map((a) => Math.abs(a - median));
  const mad = deviations.slice().sort((a, b) => a - b)[Math.floor(deviations.length / 2)] || 0;

  const outlierThreshold = mad * 3 || 0.001; // fallback small threshold
  const downweightFactor = 0.2;
  let outliersRemoved = false;

  present.forEach((p) => {
    if (Math.abs((p.apy! - median)) > outlierThreshold) {
      // downweight outliers instead of dropping
      p.weight = (p.weight ?? 0) * downweightFactor;
      outliersRemoved = true;
    }
  });

  // renormalize weights
  const total = present.reduce((s, p) => s + (p.weight ?? 0), 0) || 1;
  present.forEach((p) => (p.weight = (p.weight ?? 0) / total));

  // Step 3: compute weighted mean
  const consensusApy = present.reduce((s, p) => s + (p.apy! * (p.weight ?? 0)), 0);

  if (outliersRemoved) reasons.push('outliers_downweighted');
  if (present.length < 2) reasons.push('single_provider');

  const confidence = computeConfidence(readings, consensusApy);
  confidence.reasons = Array.from(new Set([...reasons, ...confidence.reasons]));

  return { consensusApy, confidence };
}

export default aggregateApy;
import NodeCache from "node-cache";
import { PROTOCOLS } from "../config/protocols";
import { normalizeYields } from "../utils/yieldNormalization";
import { fetchNetworkSnapshot } from "./stellarNetworkService";
import { freezeService } from "./freezeService";
import { RewardScheduleRegistry } from "./rewardScheduleRegistry";
import type { NormalizedYield, RawProtocolYield, RewardStream } from "../types/yields";

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

async function buildProtocolSnapshot(
  config: (typeof PROTOCOLS)[number],
  ledgerSequence: number,
  fetchedAt: string,
  network: "mainnet" | "testnet",
): Promise<RawProtocolYield> {
  const apyVarianceBps = ledgerSequence % 25;
  const tvlVarianceUsd = (ledgerSequence % 10) * 12_500;

  const currentTvl = config.baseTvlUsd + tvlVarianceUsd;
  
  // Fetch additional rewards from registry
  const registrySchedules = await RewardScheduleRegistry.getActiveSchedules(config.protocolName);
  const extraRewards: RewardStream[] = registrySchedules.map(s => ({
    tokenSymbol: s.tokenSymbol,
    emissionPerYear: RewardScheduleRegistry.calculateEmissionAt(s, new Date()) * 365,
    tokenPrice: 1.0, // Default price, should be fetched from price oracle in production
    confidence: s.confidence,
  }));

  const rewards = [...(config.rewardStreams || []), ...extraRewards];

  return {
    protocolName: config.protocolName,
    protocolType: config.protocolType,
    apyBps: config.baseApyBps + apyVarianceBps,
    tvlUsd: currentTvl,
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
    rewards,
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
    const rawYields = await Promise.all(PROTOCOLS.map((protocol) =>
      buildProtocolSnapshot(
        protocol,
        snapshot.ledgerSequence,
        snapshot.closedAt,
        snapshot.network,
      ),
    ));

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
