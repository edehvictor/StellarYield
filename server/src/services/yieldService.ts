import NodeCache from "node-cache";
import { PROTOCOLS } from "../config/protocols";
import { normalizeYields } from "../utils/yieldNormalization";
import { fetchNetworkSnapshot } from "./stellarNetworkService";
import type { NormalizedYield, RawProtocolYield } from "../types/yields";

const cache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});

const CACHE_KEY = "current-yields";

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
  };
}

export async function getYieldData(): Promise<NormalizedYield[]> {
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
    cache.set(CACHE_KEY, normalized);
    return normalized;
  } catch (error) {
    console.error("Yield fetch failed, using fallback protocol seed.", error);

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
      })),
    );

    cache.set(CACHE_KEY, fallback, 120);
    return fallback;
  }
}
