import { Queue } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CompoundJobData } from '../queues/types';

/**
 * CompoundScheduler schedules periodic auto-compound jobs for all registered vaults.
 *
 * It uses BullMQ's repeatable job API to schedule harvests at a configurable cron
 * interval (default: every 4 hours). Repeatable jobs survive worker restarts
 * because they are stored in Redis.
 *
 * To add or remove vaults, update the `VAULT_COMPOUND_SCHEDULES` list in config
 * or call `addVault` / `removeVault` at runtime.
 */
export class CompoundScheduler {
  constructor(
    private readonly compoundQueue: Queue<CompoundJobData>,
    private readonly vaults: string[] = config.contracts.vault ? [config.contracts.vault] : [],
  ) {}

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

  /** Schedule a repeatable compound job for a single vault. */
  async scheduleVault(vaultContractId: string): Promise<void> {
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
