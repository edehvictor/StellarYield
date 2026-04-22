import { rpc, xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { Queue } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { LiquidationJobData } from '../queues/types';

/**
 * Represents the on-chain state of a single CDP fetched from the
 * stablecoin manager contract.
 */
export interface CdpState {
  accountAddress: string;
  collateral: bigint;
  debtShares: bigint;
  /** Collateral Ratio in basis points (100% = 10000) */
  crBps: number;
}

/**
 * VaultMonitor continuously scans the StablecoinManager contract for
 * undercollateralized CDPs and enqueues them for liquidation.
 *
 * Architecture:
 *  - Uses Soroban RPC `getContractData` to read CDP entries.
 *  - Compares the CR against the configured MCR threshold.
 *  - Deduplicates using jobId = accountAddress to avoid double-queuing.
 *  - Runs on a configurable interval (default 30s).
 */
export class VaultMonitor {
  private readonly server: rpc.Server;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly liquidationQueue: Queue<LiquidationJobData>,
    private readonly contractId: string = config.contracts.stablecoinManager,
    sorobanRpcUrl: string = config.stellar.sorobanRpcUrl,
  ) {
    this.server = new rpc.Server(sorobanRpcUrl, { allowHttp: true });
  }

  /**
   * Start the monitoring loop.
   * Fires immediately, then repeats every `scanIntervalMs` milliseconds.
   */
  start(): void {
    logger.info(
      { intervalMs: config.keeper.scanIntervalMs },
      '[VaultMonitor] Starting vault scan loop',
    );
    void this.scan(); // initial scan
    this.timer = setInterval(() => void this.scan(), config.keeper.scanIntervalMs);
  }

  /** Stop the monitoring loop gracefully. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[VaultMonitor] Stopped');
    }
  }

  /**
   * Execute one scan cycle:
   *  1. Fetch all contract ledger entries for this contract.
   *  2. Filter for CDP keys (key type "CDP").
   *  3. Parse collateral and debt values.
   *  4. Flag accounts where CR < MCR.
   *  5. Add a deduplicated liquidation job per flagged account.
   */
  async scan(): Promise<void> {
    logger.debug('[VaultMonitor] Scan cycle started');

    try {
      const entries = await this.fetchAllCdpEntries();
      let flagged = 0;

      for (const entry of entries) {
        const current = await this.getCumulativeIndex();
        const cdp = this.parseEntry(entry, current);
        if (!cdp) continue;

        if (cdp.crBps < config.keeper.mcrBps) {
          flagged++;
          await this.enqueueForLiquidation(cdp);
        }
      }

      logger.info({ scanned: entries.length, flagged }, '[VaultMonitor] Scan complete');
    } catch (err) {
      logger.error({ err }, '[VaultMonitor] Scan cycle failed');
    }
  }

  /**
   * Fetch relevant CDP ledger entries to scan for liquidation.
   *
   * In the absence of a full Soroban ledger indexer, we support:
   *  1. Fallback: monitoring a specific list of addresses from config.
   *  2. Future: polling contract events (mint, liquidate) to discover new addresses.
   */
  async fetchAllCdpEntries(): Promise<rpc.Api.LedgerEntryResult[]> {
    const results: rpc.Api.LedgerEntryResult[] = [];
    const accounts = config.keeper.monitoredAddresses;

    if (accounts.length === 0) {
      logger.warn(
        '[VaultMonitor] No MONITORED_ADDRESSES configured; full scan requires an external indexer.',
      );
      return [];
    }

    // Parallel fetch for configured addresses
    const fetchPromises = accounts.map(async (addr) => {
      try {
        const key = this.buildCdpKey(addr);
        return await this.server.getContractData(this.contractId, key, rpc.Durability.Persistent);
      } catch (err) {
        // Entry might not exist (No CDP for this user yet)
        return null;
      }
    });

    const entries = await Promise.all(fetchPromises);
    return entries.filter((e): e is rpc.Api.LedgerEntryResult => e !== null);
  }

  /** Build the XDR contract data key for a CDP entry: { CDP: Address } */
  private buildCdpKey(address: string): xdr.ScVal {
    const addrScVal = new Address(address).toScVal();
    const mapEntry = new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('CDP'),
      val: addrScVal,
    });
    return xdr.ScVal.scvMap([mapEntry]);
  }

  /**
   * Fetch the current cumulative interest index from contract storage.
   * Used to convert debt shares → actual debt.
   */
  async getCumulativeIndex(): Promise<bigint> {
    try {
      const key = xdr.ScVal.scvSymbol('CumulativeIndex');
      // SDK v14: Durability is on rpc.Durability, not rpc.Api.Durability
      const response = await this.server.getContractData(
        this.contractId,
        key,
        rpc.Durability.Persistent,
      );
      // val is xdr.LedgerEntryData; .contractData().val() yields the xdr.ScVal
      const scVal = response.val.contractData().val();
      const native = scValToNative(scVal);
      return BigInt(native as string);
    } catch {
      return BigInt('1000000000000000000'); // Default 1e18
    }
  }

  /**
   * Parse a raw ledger entry into a typed CdpState.
   *
   * `entry.val` is `xdr.LedgerEntryData`; we call `.contractData()` to reach
   * the contract-data body — the same pattern used in `getCumulativeIndex`.
   * Any unexpected shape is swallowed by the outer try/catch and returns null.
   *
   * Returns null for entries that are not valid CDP map keys.
   */
  parseEntry(
    entry: rpc.Api.LedgerEntryResult,
    cumulativeIndex: bigint,
  ): CdpState | null {
    try {
      // entry.val is xdr.LedgerEntryData; .contractData() gives ContractDataEntry
      const body = entry.val.contractData();
      const keyScVal = body.key();

      // CDP keys are maps with a "CDP" discriminant
      if (keyScVal.switch() !== xdr.ScValType.scvMap()) return null;

      const keyMap = keyScVal.map() ?? [];
      const typeEntry = keyMap.find((e) => {
        const k = e.key();
        return k.switch() === xdr.ScValType.scvSymbol() && k.sym().toString() === 'CDP';
      });
      if (!typeEntry) return null;

      const accountAddress = scValToNative(typeEntry.val()) as string;

      // Parse the CDP struct value
      const valScVal = body.val();
      const valMap: xdr.ScMapEntry[] = valScVal.map() ?? [];

      const getField = (name: string): bigint => {
        const e = valMap.find((mapEntry) => mapEntry.key().sym().toString() === name);
        if (!e) return 0n;
        return BigInt(scValToNative(e.val()) as string);
      };

      const collateral = getField('collateral');
      const debtShares = getField('debt_shares');
      const SCALAR_18 = BigInt('1000000000000000000');
      const debtValue = (debtShares * cumulativeIndex) / SCALAR_18;

      const crBps =
        debtValue === 0n
          ? 999_999
          : Number((collateral * 10_000n) / debtValue);

      return { accountAddress, collateral, debtShares, crBps };
    } catch {
      return null;
    }
  }

  /** Add a liquidation job to the queue, deduplicating by account address. */
  private async enqueueForLiquidation(cdp: CdpState): Promise<void> {
    const jobId = `liquidate:${cdp.accountAddress}`;
    const data: LiquidationJobData = {
      accountAddress: cdp.accountAddress,
      currentCrBps: cdp.crBps,
      collateralValueUsd: cdp.collateral.toString(),
      debtAmount: cdp.debtShares.toString(),
    };

    await this.liquidationQueue.add(jobId, data, {
      jobId, // deduplicate — BullMQ ignores duplicate IDs of existing active jobs
    });

    logger.warn(
      { accountAddress: cdp.accountAddress, crBps: cdp.crBps },
      '[VaultMonitor] Flagged account for liquidation',
    );
  }
}
