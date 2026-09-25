/**
 * Yield Data Source Quorum Policy & Service
 *
 * Defines quorum requirements (minimum active source count and freshness window)
 * per protocol before publishing aggregate yield data.
 */

export interface ProtocolQuorumConfig {
  protocol: string;
  /** Minimum number of valid, fresh sources required to meet quorum. Default: 2 */
  minSourceCount: number;
  /** Maximum data age in seconds for a source reading to be considered fresh. Default: 900 (15 min) */
  maxFreshnessAgeSeconds: number;
  /** Whether quorum failure should prevent publishing aggregate APY. Default: false */
  requireQuorumToPublish: boolean;
}

export interface QuorumEvaluatedSource {
  provider: string;
  apy: number | null;
  ageSeconds: number | null;
  isFresh: boolean;
  isFailing: boolean;
  isValid: boolean;
  reason?: string;
}

export interface QuorumStatus {
  isMet: boolean;
  protocol: string;
  requiredMinSources: number;
  validSourceCount: number;
  totalSourceCount: number;
  freshSourceCount: number;
  staleSourceCount: number;
  failingSourceCount: number;
  maxAllowedAgeSeconds: number;
  reasons: string[];
  evaluatedSources: QuorumEvaluatedSource[];
}

export interface ProviderReadingInput {
  provider: string;
  apy?: number | null;
  weight?: number;
  timestamp?: number | string;
  fetchedAt?: string;
  isStale?: boolean;
  status?: string;
  isFailing?: boolean;
  consecutiveFailures?: number;
}

const DEFAULT_QUORUM_CONFIGS: Record<string, ProtocolQuorumConfig> = {
  blend: {
    protocol: "Blend",
    minSourceCount: 2,
    maxFreshnessAgeSeconds: 900,
    requireQuorumToPublish: false,
  },
  soroswap: {
    protocol: "Soroswap",
    minSourceCount: 2,
    maxFreshnessAgeSeconds: 900,
    requireQuorumToPublish: false,
  },
  defindex: {
    protocol: "DeFindex",
    minSourceCount: 2,
    maxFreshnessAgeSeconds: 900,
    requireQuorumToPublish: false,
  },
  default: {
    protocol: "Default",
    minSourceCount: 2,
    maxFreshnessAgeSeconds: 900,
    requireQuorumToPublish: false,
  },
};

export class YieldQuorumService {
  private configs: Map<string, ProtocolQuorumConfig> = new Map();

  constructor() {
    for (const [key, cfg] of Object.entries(DEFAULT_QUORUM_CONFIGS)) {
      this.configs.set(key.toLowerCase(), { ...cfg });
    }
  }

  /**
   * Retrieve quorum configuration for a protocol (or default).
   */
  public getConfig(protocol: string): ProtocolQuorumConfig {
    const key = protocol.toLowerCase();
    const existing = this.configs.get(key);
    if (existing) {
      return { ...existing };
    }
    const def = this.configs.get("default")!;
    return { ...def, protocol };
  }

  /**
   * Set or override quorum configuration for a protocol.
   */
  public setConfig(protocol: string, config: Partial<ProtocolQuorumConfig>): void {
    const key = protocol.toLowerCase();
    const current = this.getConfig(protocol);
    this.configs.set(key, { ...current, ...config, protocol });
  }

  /**
   * Evaluate whether a set of provider readings meets quorum for a protocol.
   */
  public evaluateQuorum(
    protocol: string,
    readings: ProviderReadingInput[],
    now: number = Date.now(),
  ): QuorumStatus {
    const config = this.getConfig(protocol);
    const reasons: string[] = [];

    if (!readings || readings.length === 0) {
      reasons.push("no_sources_provided");
      return {
        isMet: false,
        protocol: config.protocol,
        requiredMinSources: config.minSourceCount,
        validSourceCount: 0,
        totalSourceCount: 0,
        freshSourceCount: 0,
        staleSourceCount: 0,
        failingSourceCount: 0,
        maxAllowedAgeSeconds: config.maxFreshnessAgeSeconds,
        reasons,
        evaluatedSources: [],
      };
    }

    let freshSourceCount = 0;
    let staleSourceCount = 0;
    let failingSourceCount = 0;
    let validSourceCount = 0;

    const evaluatedSources: QuorumEvaluatedSource[] = readings.map((r) => {
      const apy = typeof r.apy === "number" && !Number.isNaN(r.apy) ? r.apy : null;
      let ageSeconds: number | null = null;

      if (r.fetchedAt) {
        const fetchMs = new Date(r.fetchedAt).getTime();
        if (Number.isFinite(fetchMs)) {
          ageSeconds = Math.max(0, Math.round((now - fetchMs) / 1000));
        }
      } else if (r.timestamp) {
        const tsMs = typeof r.timestamp === "number" ? r.timestamp : new Date(r.timestamp).getTime();
        if (Number.isFinite(tsMs)) {
          ageSeconds = Math.max(0, Math.round((now - tsMs) / 1000));
        }
      }

      const isFailing =
        r.isFailing === true ||
        r.status === "unavailable" ||
        r.status === "unreliable" ||
        (r.consecutiveFailures ?? 0) >= 3;

      let isFresh = true;
      if (r.isStale === true) {
        isFresh = false;
      } else if (ageSeconds !== null && ageSeconds > config.maxFreshnessAgeSeconds) {
        isFresh = false;
      }

      const hasValidApy = apy !== null;
      const isValid = hasValidApy && !isFailing && isFresh;

      if (isFailing) {
        failingSourceCount++;
      }
      if (isFresh) {
        freshSourceCount++;
      } else {
        staleSourceCount++;
      }
      if (isValid) {
        validSourceCount++;
      }

      let sourceReason: string | undefined;
      if (isFailing) {
        sourceReason = "source_failing";
      } else if (!isFresh) {
        sourceReason = `source_stale (${ageSeconds ? `${Math.round(ageSeconds / 60)}m old` : "flagged stale"})`;
      } else if (!hasValidApy) {
        sourceReason = "missing_apy";
      }

      return {
        provider: r.provider,
        apy,
        ageSeconds,
        isFresh,
        isFailing,
        isValid,
        reason: sourceReason,
      };
    });

    const isMet = validSourceCount >= config.minSourceCount;

    if (!isMet) {
      reasons.push("quorum_not_met");
      if (validSourceCount < config.minSourceCount) {
        reasons.push(`insufficient_valid_sources (${validSourceCount}/${config.minSourceCount} required)`);
      }
      if (staleSourceCount > 0) {
        reasons.push(`stale_sources_detected (${staleSourceCount})`);
      }
      if (failingSourceCount > 0) {
        reasons.push(`failing_sources_detected (${failingSourceCount})`);
      }
    }

    return {
      isMet,
      protocol: config.protocol,
      requiredMinSources: config.minSourceCount,
      validSourceCount,
      totalSourceCount: readings.length,
      freshSourceCount,
      staleSourceCount,
      failingSourceCount,
      maxAllowedAgeSeconds: config.maxFreshnessAgeSeconds,
      reasons,
      evaluatedSources,
    };
  }
}

export const yieldQuorumService = new YieldQuorumService();
