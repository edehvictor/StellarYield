import { Queue } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CompoundJobData } from '../queues/types';

/**
 * Economics snapshot for one compound window (#1534).
 * All amounts are stroops encoded as base-10 integer strings so they can be
 * compared exactly with BigInt (no floating-point drift).
 */
export interface CompoundEconomics {
  /** Gross expected reward for the window, in stroops. */
  expectedReward: string;
  /** Estimated network + protocol fees for the compound, in stroops. */
  estimatedFees: string;
}

/**
 * Provider hook returning the current economics for a vault.
 * Return null when economics cannot be determined (the scheduler then
 * compounds without the gate, preserving historical behaviour).
 */
export type CompoundEconomicsProvider = (
  vaultContractId: string,
) => Promise<CompoundEconomics | null>;

/**
 * #1534: Outcome of the minimum net-yield policy check.
 * netYield = expectedReward - estimatedFees.
 * A compound is only eligible when netYield >= minNetYield (a compound whose
 * net yield equals the threshold still runs; only strictly-below is skipped).
 */
export interface NetYieldDecision {
  eligible: boolean;
  netYield: string;
  minNetYield: string;
  reason: 'NET_YIELD_OK' | 'NET_YIELD_BELOW_THRESHOLD' | 'ECONOMICS_UNAVAILABLE';
}

/**
 * #1534: Evaluate the minimum net-yield policy for one compound decision.
 *
 * Boundary semantics: eligible when netYield >= minNetYield, skipped only
 * when netYield is strictly below minNetYield. When economics are unavailable
 * (null, or malformed amounts) the gate does not block compounding — the
 * scheduler falls back to its previous always-schedule behaviour.
 */
export function evaluateNetYield(
  economics: CompoundEconomics | null,
  minNetYield: string,
): NetYieldDecision {
  if (!economics) {
    return { eligible: true, netYield: '0', minNetYield, reason: 'ECONOMICS_UNAVAILABLE' };
  }

  let netYield: bigint;
  let threshold: bigint;
  try {
    netYield = BigInt(economics.expectedReward) - BigInt(economics.estimatedFees);
    threshold = BigInt(minNetYield);
  } catch {
    return { eligible: true, netYield: '0', minNetYield, reason: 'ECONOMICS_UNAVAILABLE' };
  }

  return {
    eligible: netYield >= threshold,
    netYield: netYield.toString(),
    minNetYield: threshold.toString(),
    reason: netYield >= threshold ? 'NET_YIELD_OK' : 'NET_YIELD_BELOW_THRESHOLD',
  };
}

/** Optional behaviour-preserving hooks for the scheduler (#1534). */
export interface CompoundSchedulerOptions {
  /** Supplies per-vault economics for the net-yield gate. Unset = no gate. */
  economicsProvider?: CompoundEconomicsProvider;
  /**
   * Minimum net-yield in stroops. Defaults to the COMPOUND_MIN_NET_YIELD
   * environment value (config.keeper.compoundMinNetYield, "0" by default).
   */
  minNetYield?: string;
}

/** Result of a scheduling attempt. */
export interface ScheduleDecision {
  scheduled: boolean;
  reason?: string;
}

/**
 * CompoundScheduler schedules periodic auto-compound jobs for all registered vaults.
 *
 * It uses BullMQ's repeatable job API to schedule harvests at a configurable cron
 * interval (default: every 4 hours). Repeatable jobs survive worker restarts
 * because they are stored in Redis.
 *
 * To add or remove vaults, update the `VAULT_COMPOUND_SCHEDULES` list in config
 * or call `addVault` / `removeVault` at runtime.
 *
 * #1534 Minimum net-yield policy:
 *  When an economics provider is configured, a vault is only (re)registered
 *  for compounding while the expected reward minus fees clears the configured
 *  `minNetYield` threshold. Vault operators can re-check at any time via
 *  `shouldCompound()`.
 */
export class CompoundScheduler {
  private readonly minNetYield: string;

  constructor(
    private readonly compoundQueue: Queue<CompoundJobData>,
    private readonly vaults: string[] = config.contracts.vault ? [config.contracts.vault] : [],
    private readonly options: CompoundSchedulerOptions = {},
  ) {
    this.minNetYield = options.minNetYield ?? config.keeper.compoundMinNetYield;
  }

  /**
   * #1534: Ask the policy whether a vault should compound right now.
   * Returns the net-yield decision (eligible when economics are unavailable
   * so behaviour is unchanged for operators without an economics feed).
   */
  async shouldCompound(vaultContractId: string): Promise<NetYieldDecision> {
    if (!this.options.economicsProvider) {
      return {
        eligible: true,
        netYield: '0',
        minNetYield: this.minNetYield,
        reason: 'ECONOMICS_UNAVAILABLE',
      };
    }

    let economics: CompoundEconomics | null = null;
    try {
      economics = await this.options.economicsProvider(vaultContractId);
    } catch (err) {
      logger.warn(
        { err, vaultContractId },
        '[CompoundScheduler] Economics provider failed — net-yield gate skipped',
      );
    }

    return evaluateNetYield(economics, this.minNetYield);
  }

  /**
   * Register repeatable compound jobs for all vaults.
   * Idempotent — calling multiple times for the same vault is safe.
   */
  async start(): Promise<void> {
    for (const vaultId of this.vaults) {
      await this.scheduleVault(vaultId);
    }
    logger.info({ vaultCount: this.vaults.length }, '[CompoundScheduler] All vaults scheduled');
  }

  /**
   * Schedule a repeatable compound job for a single vault.
   *
   * #1534: When an economics provider is configured, the job is only
   * registered if the expected net yield clears the policy threshold.
   */
  async scheduleVault(vaultContractId: string): Promise<ScheduleDecision> {
    const decision = await this.shouldCompound(vaultContractId);
    if (!decision.eligible) {
      logger.info(
        { vaultContractId, ...decision },
        '[CompoundScheduler] Skipping compound — net yield below policy threshold (#1534)',
      );
      return { scheduled: false, reason: decision.reason };
    }

    const jobId = `compound:${vaultContractId}`;
    const data: CompoundJobData = {
      vaultContractId,
      minHarvestAmount: '0', // Keeper accepts any amount; production should set a floor
    };

    await this.compoundQueue.add(jobId, data, {
      jobId,
      repeat: {
        pattern: '0 */4 * * *', // Every 4 hours
      },
    });

    logger.info({ vaultContractId }, '[CompoundScheduler] Vault compound job scheduled');
    return { scheduled: true };
  }

  /** Add a new vault to the compound rotation at runtime. */
  async addVault(vaultContractId: string): Promise<void> {
    this.vaults.push(vaultContractId);
    await this.scheduleVault(vaultContractId);
  }

  /** Remove a vault from the compound rotation. */
  async removeVault(vaultContractId: string): Promise<void> {
    const idx = this.vaults.indexOf(vaultContractId);
    if (idx !== -1) {
      this.vaults.splice(idx, 1);
    }
    await this.compoundQueue.removeRepeatable(
      `compound:${vaultContractId}`,
      { pattern: '0 */4 * * *' },
    );
    logger.info({ vaultContractId }, '[CompoundScheduler] Vault compound job removed');
  }
}
