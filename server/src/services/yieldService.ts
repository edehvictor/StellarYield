import computeConfidence from './confidenceService';
import {
  yieldQuorumService,
  type QuorumStatus,
  type ProviderReadingInput,
} from './yieldQuorumService';

export type ProviderReading = ProviderReadingInput;

export function aggregateApy(readings: ProviderReading[], protocol: string = 'default') {
  const reasons: string[] = [];
  const quorumStatus = yieldQuorumService.evaluateQuorum(protocol, readings);

  if (!readings || readings.length === 0) {
    reasons.push('no_readings');
    return {
      consensusApy: null,
      confidence: { score: 0, reasons: Array.from(new Set([...reasons, ...quorumStatus.reasons])) },
      quorumStatus,
    };
  }

  // Step 1: normalize weights and filter missing
  const available = readings.map((r) => ({ ...r }));
  const present = available.filter((r) => typeof r.apy === 'number' && !Number.isNaN(r.apy));
  if (present.length === 0) {
    reasons.push('missing_all_apy');
    return {
      consensusApy: null,
      confidence: { score: 0, reasons: Array.from(new Set([...reasons, ...quorumStatus.reasons])) },
      quorumStatus,
    };
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

  // Step 4: Enforce Quorum Policy - degrade confidence if quorum is not met
  if (!quorumStatus.isMet) {
    reasons.push(...quorumStatus.reasons);
    // Degrade score by multiplying by 0.5 and subtracting a 15-point penalty
    confidence.score = Math.max(0, Math.round(confidence.score * 0.5 - 15));
  }

  confidence.reasons = Array.from(new Set([...reasons, ...confidence.reasons]));

  return { consensusApy, confidence, quorumStatus };
}

export default aggregateApy;
import NodeCache from "node-cache";
import { PROTOCOLS } from "../config/protocols";
import {
  YIELD_NORMALIZATION_CONTRACT,
  blendApyPercent,
  checkYieldParity,
  normalizeUsd,
  normalizeYields,
  roundTo,
  type ComparableYield,
  type YieldParityReport,
} from "../utils/yieldNormalization";
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
      PROTOCOLS.map((p) => ({
        protocolName: p.protocolName,
        protocolType: p.protocolType,
        apyBps: p.baseApyBps,
        tvlUsd: p.baseTvlUsd,
        volatilityPct: p.volatilityPct,
        protocolAgeDays: p.protocolAgeDays,
        network: "testnet",
        source: p.source,
        fetchedAt: new Date().toISOString(),
        liquidityUsd: p.liquidityUsd,
        rebalancingBehavior: p.rebalancingBehavior,
        managementFeeBps: p.managementFeeBps,
        performanceFeeBps: p.performanceFeeBps,
        capitalEfficiencyPct: p.capitalEfficiencyPct,
        rewards: p.rewardStreams || [],
        attribution: {
          baseYield: (p.baseApyBps / 100) * 0.8,
          incentives: (p.baseApyBps / 100) * 0.1,
          compounding: (p.baseApyBps / 100) * 0.05,
          tacticalRotation: (p.baseApyBps / 100) * 0.05,
        },
      })),
    );

    cache.set(CACHE_KEY, fallback, FALLBACK_TTL_SECONDS);
    return fallback;
  }
}

// ── Portfolio yield summaries ───────────────────────────────────────────
//
// A portfolio summary is a second consumer of the same market feed: it weights
// each protocol's normalized yield by the USD sitting in it. Historically this
// side recomputed its own percentages, which is how the feed and the summary
// drifted apart in the second decimal. Per the normalization contract, the
// summary now *derives* from the emitted normalized values and only performs
// the weighting itself — and `getYieldParityReport()` proves it still does.

/** A position to summarise: how much USD is sitting in a given protocol. */
export interface PortfolioPositionInput {
  protocol: string;
  valueUsd: number;
}

export interface PortfolioYieldSummaryPosition extends ComparableYield {
  valueUsd: number;
  /** Share of the portfolio, in percent, at contract precision. */
  weightPct: number;
  /** This position's share of `blendedTotalApy`, in percent. */
  contributionApy: number;
}

export interface PortfolioYieldSummary {
  contractVersion: string;
  generatedAt: string;
  totalValueUsd: number;
  blendedApy: number;
  blendedRewardApy: number;
  blendedTotalApy: number;
  blendedNetApy: number;
  positions: PortfolioYieldSummaryPosition[];
  /** Positions whose protocol has no entry in the market feed. */
  unpricedProtocols: string[];
}

/**
 * Weights a market-feed snapshot by portfolio positions.
 *
 * Every per-protocol figure is carried through from `feed` unchanged — the
 * summary must never re-derive a percentage the feed already normalized. Only
 * the blended figures are new arithmetic, and they round once, at the end.
 */
export function buildPortfolioYieldSummary(
  positions: PortfolioPositionInput[],
  feed: NormalizedYield[],
): PortfolioYieldSummary {
  const feedByProtocol = new Map(feed.map((entry) => [entry.protocolName, entry]));

  const matched: Array<{ position: PortfolioPositionInput; entry: NormalizedYield }> = [];
  const unpricedProtocols: string[] = [];

  for (const position of positions) {
    const entry = feedByProtocol.get(position.protocol);
    if (!entry) {
      unpricedProtocols.push(position.protocol);
      continue;
    }
    matched.push({ position, entry });
  }

  const totalValueUsdPrecise = matched.reduce(
    (sum, { position }) => sum + Math.max(0, position.valueUsd),
    0,
  );

  const summaryPositions: PortfolioYieldSummaryPosition[] = matched.map(({ position, entry }) => {
    const weight = Math.max(0, position.valueUsd);
    const weightFraction = totalValueUsdPrecise > 0 ? weight / totalValueUsdPrecise : 0;

    return {
      protocol: entry.protocolName,
      apy: entry.apy,
      rewardApy: entry.rewardApy,
      totalApy: entry.totalApy,
      netApy: entry.netApy,
      tvl: entry.tvl,
      valueUsd: normalizeUsd(position.valueUsd),
      weightPct: roundTo(weightFraction * 100, 2),
      contributionApy: roundTo(entry.totalApy * weightFraction, 2),
    };
  });

  const weighted = (field: "apy" | "rewardApy" | "totalApy" | "netApy") =>
    blendApyPercent(
      matched.map(({ position, entry }) => ({
        apyPercent: entry[field],
        weight: Math.max(0, position.valueUsd),
      })),
    );

  return {
    contractVersion: YIELD_NORMALIZATION_CONTRACT.version,
    generatedAt: new Date().toISOString(),
    totalValueUsd: normalizeUsd(totalValueUsdPrecise),
    blendedApy: weighted("apy"),
    blendedRewardApy: weighted("rewardApy"),
    blendedTotalApy: weighted("totalApy"),
    blendedNetApy: weighted("netApy"),
    positions: summaryPositions,
    unpricedProtocols,
  };
}

/** Equal-weight positions across the whole feed, used when no portfolio is supplied. */
function equalWeightPositions(feed: NormalizedYield[]): PortfolioPositionInput[] {
  return feed.map((entry) => ({ protocol: entry.protocolName, valueUsd: 1 }));
}

/** Builds a portfolio summary against the live market feed. */
export async function getPortfolioYieldSummary(
  positions?: PortfolioPositionInput[],
): Promise<PortfolioYieldSummary> {
  const feed = await getYieldData();
  return buildPortfolioYieldSummary(positions ?? equalWeightPositions(feed), feed);
}

/**
 * Runs the feed-vs-summary parity check against the live market feed.
 *
 * Served by `GET /api/yields/parity` so operators can see a normalization drift
 * without waiting for CI, and asserted by the parity tests so a drift is a
 * build failure.
 */
export async function getYieldParityReport(
  positions?: PortfolioPositionInput[],
): Promise<YieldParityReport & { summary: PortfolioYieldSummary }> {
  const feed = await getYieldData();
  const summary = buildPortfolioYieldSummary(positions ?? equalWeightPositions(feed), feed);

  const comparableFeed: ComparableYield[] = feed
    .filter((entry) => summary.positions.some((p) => p.protocol === entry.protocolName))
    .map((entry) => ({
      protocol: entry.protocolName,
      apy: entry.apy,
      rewardApy: entry.rewardApy,
      totalApy: entry.totalApy,
      netApy: entry.netApy,
      tvl: entry.tvl,
    }));

  return { ...checkYieldParity(comparableFeed, summary.positions), summary };
}
