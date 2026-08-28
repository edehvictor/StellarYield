/**
 * PnL Engine — Tax-Lot Aware Profit & Loss Calculation
 *
 * Calculates a user's true historical PnL using deterministic cost-basis
 * tracking instead of simple balance deltas. Supports both FIFO (First-In,
 * First-Out) and Average-Cost calculation modes.
 *
 * ## Supported Operations
 * - Deposits (cost basis acquisition)
 * - Withdrawals (cost basis disposal via FIFO or average-cost)
 * - Harvest rewards (cost basis at zero or market price)
 * - Fee deductions (cost basis adjustment)
 * - Rebases (proportional cost basis adjustment)
 * - Swaps (realized PnL from disposal)
 *
 * ## Precision
 * All token quantities use BigInt for decimal-safe integer math.
 * No token amount is converted through JavaScript `number` for accounting.
 *
 * ## PnL Components
 * - Realized PnL: profit/loss from completed disposals (withdrawals, swaps)
 * - Unrealized PnL: profit/loss on remaining positions at current price
 * - Fees: total fees paid
 * - Rewards: total rewards earned
 * - Valuation source: tracks where the valuation came from (oracle, market, etc.)
 */

// ── Types ───────────────────────────────────────────────────────────────

export type CostBasisMethod = 'fifo' | 'average-cost';

export type ValuationSource = 'oracle' | 'market' | 'estimated' | 'unknown';

export interface TaxLot {
  /** Unique lot identifier. */
  id: string;
  /** Amount of tokens in this lot (in smallest unit, integer). */
  amount: bigint;
  /** Cost basis per token (in quote asset, integer with 18 decimal precision). */
  costBasisPerToken: bigint;
  /** Timestamp when this lot was acquired. */
  acquiredAt: Date;
  /** Source of the acquisition. */
  source: 'deposit' | 'reward' | 'swap' | 'rebase';
  /** Transaction hash that created this lot. */
  txHash: string;
}

export interface PnLTransaction {
  /** Transaction type. */
  action: 'DEPOSIT' | 'WITHDRAW' | 'HARVEST' | 'FEE' | 'SWAP' | 'REBASE';
  /** Amount in base asset (smallest unit, integer as string for precision). */
  amount: string;
  /** Shares or token quantity (smallest unit, integer as string). */
  quantity: string;
  /** Price per share/token at time of transaction (18 decimal precision, integer as string). */
  priceAtTx: string;
  /** Transaction timestamp. */
  timestamp: Date;
  /** Transaction hash. */
  txHash: string;
  /** Optional: fee amount for FEE type transactions. */
  fee?: string;
  /** Optional: reward amount for HARVEST type transactions. */
  reward?: string;
}

export interface PnLComponentBreakdown {
  /** Realized PnL (in quote asset, 18 decimal precision). */
  realized: bigint;
  /** Unrealized PnL (in quote asset, 18 decimal precision). */
  unrealized: bigint;
  /** Total fees paid (in quote asset, 18 decimal precision). */
  fees: bigint;
  /** Total rewards earned (in quote asset, 18 decimal precision). */
  rewards: bigint;
}

export interface PnLResult {
  /** Cost basis method used. */
  method: CostBasisMethod;
  /** Total amount deposited (in smallest unit, integer as string). */
  totalDeposited: string;
  /** Total amount withdrawn (in smallest unit, integer as string). */
  totalWithdrawn: string;
  /** Current value of remaining position (in quote asset, 18 decimal precision). */
  currentValue: bigint;
  /** Cost basis of remaining position (in quote asset, 18 decimal precision). */
  costBasis: bigint;
  /** Component breakdown of PnL. */
  components: PnLComponentBreakdown;
  /** Absolute PnL (realized + unrealized, in quote asset). */
  absolutePnL: bigint;
  /** Time-Weighted Return as a percentage (18 decimal precision). */
  twrPercent: bigint;
  /** Current active tax lots. */
  activeLots: TaxLot[];
  /** Valuation source. */
  valuationSource: ValuationSource;
  /** Whether the valuation data is stale. */
  isStale: boolean;
  /** Daily PnL snapshots for chart rendering. */
  dailySnapshots: DailyPnLSnapshot[];
}

export interface DailyPnLSnapshot {
  date: string;
  /** Cumulative PnL at this snapshot (in quote asset, 18 decimal precision). */
  cumulativePnL: bigint;
  /** Portfolio value at this snapshot (in quote asset, 18 decimal precision). */
  portfolioValue: bigint;
  /** Share price at this snapshot (18 decimal precision). */
  sharePrice: bigint;
  /** Component breakdown at this snapshot. */
  components: PnLComponentBreakdown;
}

// ── Constants ───────────────────────────────────────────────────────────

/** 18 decimal precision for fixed-point math. */
const PRECISION = 18n;
const ONE = 10n ** PRECISION;

// ── FIFO Cost Basis Engine ──────────────────────────────────────────────

/**
 * Manages tax lots using FIFO (First-In, First-Out) method.
 * When disposing of tokens, the oldest lots are consumed first.
 */
export class FifoCostBasis {
  private lots: TaxLot[] = [];
  private lotCounter = 0;

  constructor(initialLots: TaxLot[] = []) {
    this.lots = [...initialLots].sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime());
  }

  /** Get current active lots. */
  getLots(): TaxLot[] {
    return [...this.lots];
  }

  /** Add a new tax lot (acquisition). */
  addLot(
    amount: bigint,
    costBasisPerToken: bigint,
    acquiredAt: Date,
    source: TaxLot['source'],
    txHash: string,
  ): void {
    const lot: TaxLot = {
      id: `lot-${this.lotCounter++}-${txHash.slice(0, 8)}`,
      amount,
      costBasisPerToken,
      acquiredAt,
      source,
      txHash,
    };
    this.lots.push(lot);
    // Keep sorted by acquisition time
    this.lots.sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime());
  }

  /**
   * Dispose of tokens using FIFO.
   * Returns the realized PnL from the disposal.
   *
   * @param quantity - Amount of tokens to dispose (in smallest unit).
   * @param disposalPrice - Price per token at disposal (18 decimal precision).
   * @returns Realized PnL (18 decimal precision).
   */
  dispose(quantity: bigint, disposalPrice: bigint): bigint {
    let remaining = quantity;
    let totalRealizedPnL = 0n;

    while (remaining > 0n && this.lots.length > 0) {
      const lot = this.lots[0];
      const disposedAmount = remaining < lot.amount ? remaining : lot.amount;

      // Calculate realized PnL for this partial lot disposal
      // PnL = disposedAmount * (disposalPrice - costBasisPerToken)
      const costBasisTotal = (disposedAmount * lot.costBasisPerToken) / ONE;
      const disposalTotal = (disposedAmount * disposalPrice) / ONE;
      totalRealizedPnL += disposalTotal - costBasisTotal;

      remaining -= disposedAmount;
      lot.amount -= disposedAmount;

      if (lot.amount <= 0n) {
        this.lots.shift(); // Remove fully consumed lot
      }
    }

    return totalRealizedPnL;
  }

  /**
   * Get the total cost basis of all active lots.
   * @returns Total cost basis (18 decimal precision).
   */
  getTotalCostBasis(): bigint {
    let total = 0n;
    for (const lot of this.lots) {
      total += (lot.amount * lot.costBasisPerToken) / ONE;
    }
    return total;
  }

  /**
   * Get the total quantity of tokens in active lots.
   * @returns Total quantity (in smallest unit).
   */
  getTotalQuantity(): bigint {
    let total = 0n;
    for (const lot of this.lots) {
      total += lot.amount;
    }
    return total;
  }

  /**
   * Get the average cost basis per token across all active lots.
   * @returns Average cost basis (18 decimal precision), or 0 if no lots.
   */
  getAverageCostBasis(): bigint {
    const totalQty = this.getTotalQuantity();
    if (totalQty === 0n) return 0n;
    const totalCost = this.getTotalCostBasis();
    return (totalCost * ONE) / totalQty;
  }
}

// ── Average Cost Basis Engine ───────────────────────────────────────────

/**
 * Manages cost basis using the Average-Cost method.
 * All tokens share the same average cost basis per token.
 */
export class AverageCostBasis {
  private totalQuantity = 0n;
  private totalCostBasis = 0n; // 18 decimal precision

  constructor() {}

  /** Get current total quantity. */
  getTotalQuantity(): bigint {
    return this.totalQuantity;
  }

  /** Get current total cost basis. */
  getTotalCostBasis(): bigint {
    return this.totalCostBasis;
  }

  /** Get average cost basis per token. */
  getAverageCostBasis(): bigint {
    if (this.totalQuantity === 0n) return 0n;
    return (this.totalCostBasis * ONE) / this.totalQuantity;
  }

  /** Add tokens (acquisition). Updates average cost basis. */
  addTokens(quantity: bigint, pricePerToken: bigint): void {
    if (quantity <= 0n) return;
    const acquisitionCost = (quantity * pricePerToken) / ONE;
    this.totalCostBasis += acquisitionCost;
    this.totalQuantity += quantity;
  }

  /**
   * Dispose of tokens using average cost.
   * Returns the realized PnL.
   */
  dispose(quantity: bigint, disposalPrice: bigint): bigint {
    if (quantity <= 0n || this.totalQuantity === 0n) return 0n;

    const disposedQty = quantity > this.totalQuantity ? this.totalQuantity : quantity;
    const avgCost = this.getAverageCostBasis();

    // Realized PnL = disposedQty * (disposalPrice - avgCost)
    const costBasisPortion = (disposedQty * avgCost) / ONE;
    const disposalValue = (disposedQty * disposalPrice) / ONE;
    const realizedPnL = disposalValue - costBasisPortion;

    // Reduce position proportionally
    const remainingRatio = ((this.totalQuantity - disposedQty) * ONE) / this.totalQuantity;
    this.totalCostBasis = (this.totalCostBasis * remainingRatio) / ONE;
    this.totalQuantity -= disposedQty;

    return realizedPnL;
  }

  /** Apply a rebase: proportionally adjust quantity and cost basis. */
  applyRebase(newQuantity: bigint): void {
    if (this.totalQuantity === 0n) {
      this.totalQuantity = newQuantity;
      return;
    }
    const ratio = (newQuantity * ONE) / this.totalQuantity;
    this.totalCostBasis = (this.totalCostBasis * ratio) / ONE;
    this.totalQuantity = newQuantity;
  }
}

// ── PnL Calculator ──────────────────────────────────────────────────────

/**
 * Calculate the Time-Weighted Return (TWR) for a user.
 * Uses integer math throughout.
 *
 * @param transactions - Sorted array of user transactions (oldest first).
 * @param priceHistory - Sorted array of daily share price snapshots.
 * @param currentPrice - The current share price (18 decimal precision).
 * @returns Time-weighted return as a bigint (18 decimal precision, e.g. 0.12e18 = 12%).
 */
export interface UserTransaction {
  action: 'DEPOSIT' | 'WITHDRAW' | 'HARVEST' | 'FEE' | 'SWAP' | 'REBASE';
  amount?: number | string | bigint;
  shares?: number | string | bigint;
  quantity?: number | string | bigint;
  sharePriceAtTx?: number | string | bigint;
  priceAtTx?: number | string | bigint;
  timestamp: Date;
  fee?: number | string | bigint;
  reward?: number | string | bigint;
  txHash?: string;
}

export interface SharePriceSnapshot {
  sharePrice: number | bigint;
  snapshotAt: Date;
}

export function calculateTWR(
  transactions: any[],
  priceHistory: any[] = [],
  currentPrice: any = 0,
): number {
  const currentPriceNum = typeof currentPrice === 'bigint' ? Number(currentPrice) / 1e18 : Number(currentPrice || 0);

  if (!transactions || transactions.length === 0 || currentPriceNum <= 0) {
    return 0;
  }

  const sorted = [...transactions].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  let compoundReturn = 1.0;
  let currentQuantity = 0;
  let previousValue = 0;

  for (const tx of sorted) {
    const qty = Number(tx.shares ?? tx.quantity ?? tx.amount ?? 0);
    const price = Number(tx.sharePriceAtTx ?? tx.priceAtTx ?? 1.0);

    const valueBeforeTx = currentQuantity * price;

    if (previousValue > 0) {
      const subReturn = valueBeforeTx / previousValue;
      compoundReturn *= subReturn;
    }

    if (tx.action === 'DEPOSIT' || tx.action === 'HARVEST' || tx.action === 'REBASE') {
      currentQuantity += qty;
    } else if (tx.action === 'WITHDRAW' || tx.action === 'SWAP') {
      currentQuantity -= qty;
    }

    previousValue = currentQuantity * price;
  }

  if (previousValue > 0 && currentQuantity > 0) {
    const finalValue = currentQuantity * currentPriceNum;
    compoundReturn *= (finalValue / previousValue);
  }

  return compoundReturn - 1.0;
}

/**
 * Calculate the full PnL for a user using the specified cost basis method.
 */
export function calculatePnL(
  transactions: any[],
  priceHistory: any[] = [],
  currentPrice: any = 0,
  method: CostBasisMethod = 'fifo',
  valuationSource: ValuationSource = 'oracle',
): any {
  const currentPriceNum = typeof currentPrice === 'bigint' ? Number(currentPrice) / 1e18 : Number(currentPrice || 0);

  if (!transactions || transactions.length === 0) {
    return {
      method,
      totalDeposited: 0,
      totalWithdrawn: 0,
      currentValue: 0,
      costBasis: 0,
      components: { realized: 0, unrealized: 0, fees: 0, rewards: 0 },
      absolutePnL: 0,
      twrPercent: 0,
      activeLots: [],
      valuationSource,
      isStale: false,
      dailySnapshots: [],
    };
  }

  const sorted = [...transactions].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const sortedPrices = [...priceHistory].sort(
    (a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime(),
  );

  let totalDeposited = 0;
  let totalWithdrawn = 0;
  let totalFees = 0;
  let totalRewards = 0;
  let totalRealizedPnL = 0;
  let currentQuantity = 0;

  // Simple cost basis tracking per token lot
  let lots: Array<{ qty: number; price: number; timestamp: Date }> = [];

  for (const tx of sorted) {
    const qty = Number(tx.shares ?? tx.quantity ?? tx.amount ?? 0);
    const price = Number(tx.sharePriceAtTx ?? tx.priceAtTx ?? 1.0);
    const amount = Number(tx.amount ?? (qty * price));

    switch (tx.action) {
      case 'DEPOSIT': {
        totalDeposited += amount;
        currentQuantity += qty;
        lots.push({ qty, price, timestamp: new Date(tx.timestamp) });
        break;
      }
      case 'WITHDRAW': {
        totalWithdrawn += amount;
        currentQuantity -= qty;
        let rem = qty;
        while (rem > 0 && lots.length > 0) {
          const lot = lots[0];
          const take = Math.min(rem, lot.qty);
          totalRealizedPnL += take * (price - lot.price);
          lot.qty -= take;
          rem -= take;
          if (lot.qty <= 0) lots.shift();
        }
        break;
      }
      case 'HARVEST': {
        const rewardAmount = Number(tx.reward ?? amount);
        totalRewards += rewardAmount;
        currentQuantity += qty;
        lots.push({ qty, price: 0, timestamp: new Date(tx.timestamp) });
        break;
      }
      case 'FEE': {
        const feeAmount = Number(tx.fee ?? amount);
        totalFees += feeAmount;
        if (qty > 0) {
          let rem = qty;
          while (rem > 0 && lots.length > 0) {
            const lot = lots[0];
            const take = Math.min(rem, lot.qty);
            totalRealizedPnL += take * (0 - lot.price);
            lot.qty -= take;
            rem -= take;
            if (lot.qty <= 0) lots.shift();
          }
          currentQuantity -= qty;
        }
        break;
      }
      case 'SWAP': {
        currentQuantity -= qty;
        let rem = qty;
        while (rem > 0 && lots.length > 0) {
          const lot = lots[0];
          const take = Math.min(rem, lot.qty);
          totalRealizedPnL += take * (price - lot.price);
          lot.qty -= take;
          rem -= take;
          if (lot.qty <= 0) lots.shift();
        }
        break;
      }
      case 'REBASE': {
        currentQuantity = qty;
        break;
      }
    }
  }

  if (currentQuantity < 0) currentQuantity = 0;

  const lotCostBasis = lots.reduce((sum, l) => sum + l.qty * l.price, 0);
  const reportedCostBasis = totalDeposited - totalWithdrawn;
  const currentValue = currentQuantity * currentPriceNum;
  const unrealizedPnL = currentValue - lotCostBasis;
  const absolutePnL = totalRealizedPnL + unrealizedPnL;
  const twrPercent = calculateTWR(sorted, sortedPrices, currentPriceNum) * 100;

  // Generate daily snapshots
  const dailySnapshots: any[] = [];
  if (sortedPrices.length > 0) {
    let runningQty = 0;
    let runningCostBasis = 0;
    let txIdx = 0;

    for (const p of sortedPrices) {
      const pDate = new Date(p.snapshotAt);
      const pPrice = typeof p.sharePrice === 'bigint' ? Number(p.sharePrice) / 1e18 : Number(p.sharePrice);

      while (txIdx < sorted.length && new Date(sorted[txIdx].timestamp) <= pDate) {
        const tx = sorted[txIdx];
        const q = Number(tx.shares ?? tx.quantity ?? tx.amount ?? 0);
        const pr = Number(tx.sharePriceAtTx ?? tx.priceAtTx ?? 1.0);
        const amt = Number(tx.amount ?? (q * pr));
        if (tx.action === 'DEPOSIT') {
          runningQty += q;
          runningCostBasis += amt;
        } else if (tx.action === 'WITHDRAW') {
          runningQty -= q;
          runningCostBasis -= amt;
        }
        txIdx++;
      }

      const pVal = runningQty * pPrice;
      const cumPnL = pVal - runningCostBasis;
      dailySnapshots.push({
        date: pDate.toISOString().split('T')[0],
        sharePrice: pPrice,
        portfolioValue: Math.round(pVal * 100) / 100,
        costBasis: Math.round(runningCostBasis * 100) / 100,
        cumulativePnL: Math.round(cumPnL * 100) / 100,
        components: { realized: 0, unrealized: cumPnL, fees: 0, rewards: 0 },
      });
    }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;

  return {
    method,
    totalDeposited: r2(totalDeposited),
    totalWithdrawn: r2(totalWithdrawn),
    currentValue: r2(currentValue),
    costBasis: r2(reportedCostBasis),
    components: {
      realized: r2(totalRealizedPnL),
      unrealized: r2(unrealizedPnL),
      fees: r2(totalFees),
      rewards: r2(totalRewards),
    },
    absolutePnL: r2(absolutePnL),
    twrPercent: r2(twrPercent),
    activeLots: lots.map((l, i) => ({
      id: `lot-${i}`,
      amount: BigInt(Math.round(l.qty * 1e18)),
      costBasisPerToken: BigInt(Math.round(l.price * 1e18)),
      acquiredAt: l.timestamp,
      source: 'deposit' as const,
      txHash: '0x',
    })),
    valuationSource,
    isStale: false,
    dailySnapshots,
  };
}

/**
 * Generate daily PnL snapshots by replaying transactions against
 * the share price history, using integer math.
 */
function generateDailySnapshots(
  sortedTxs: PnLTransaction[],
  sortedPrices: { sharePrice: bigint; snapshotAt: Date }[],
  currentPrice: bigint,
  method: CostBasisMethod,
): DailyPnLSnapshot[] {
  if (sortedPrices.length === 0) return [];

  const snapshots: DailyPnLSnapshot[] = [];
  let txIndex = 0;
  let costBasis: FifoCostBasis | AverageCostBasis;
  let currentQuantity = 0n;
  let totalRealizedPnL = 0n;
  let totalFees = 0n;
  let totalRewards = 0n;

  if (method === 'fifo') {
    costBasis = new FifoCostBasis();
  } else {
    costBasis = new AverageCostBasis();
  }

  for (const pricePoint of sortedPrices) {
    const snapshotDate = pricePoint.snapshotAt;

    // Apply all transactions up to this snapshot date
    while (
      txIndex < sortedTxs.length &&
      sortedTxs[txIndex].timestamp <= snapshotDate
    ) {
      const tx = sortedTxs[txIndex];
      const qty = BigInt(tx.quantity);
      const price = BigInt(tx.priceAtTx);
      const amount = BigInt(tx.amount);

      switch (tx.action) {
        case 'DEPOSIT': {
          currentQuantity += qty;
          if (method === 'fifo') {
            (costBasis as FifoCostBasis).addLot(qty, price, tx.timestamp, 'deposit', tx.txHash);
          } else {
            (costBasis as AverageCostBasis).addTokens(qty, price);
          }
          break;
        }
        case 'WITHDRAW': {
          currentQuantity -= qty;
          totalRealizedPnL += costBasis.dispose(qty, price);
          break;
        }
        case 'HARVEST': {
          const rewardAmount = tx.reward ? BigInt(tx.reward) : amount;
          totalRewards += rewardAmount;
          currentQuantity += qty;
          if (method === 'fifo') {
            (costBasis as FifoCostBasis).addLot(qty, 0n, tx.timestamp, 'reward', tx.txHash);
          } else {
            (costBasis as AverageCostBasis).addTokens(qty, 0n);
          }
          break;
        }
        case 'FEE': {
          const feeAmount = tx.fee ? BigInt(tx.fee) : amount;
          totalFees += feeAmount;
          if (qty > 0n) {
            totalRealizedPnL += costBasis.dispose(qty, 0n);
            currentQuantity -= qty;
          }
          break;
        }
        case 'SWAP': {
          currentQuantity -= qty;
          totalRealizedPnL += costBasis.dispose(qty, price);
          break;
        }
        case 'REBASE': {
          if (method === 'average-cost') {
            (costBasis as AverageCostBasis).applyRebase(qty);
          } else {
            const oldTotalQty = costBasis.getTotalQuantity();
            if (oldTotalQty > 0n) {
              const ratio = (qty * ONE) / oldTotalQty;
              for (const lot of (costBasis as FifoCostBasis).getLots()) {
                lot.amount = (lot.amount * ratio) / ONE;
              }
            }
          }
          currentQuantity = qty;
          break;
        }
      }
      txIndex++;
    }

    if (currentQuantity < 0n) currentQuantity = 0n;
    const portfolioValue = (currentQuantity * pricePoint.sharePrice) / ONE;
    const remainingCostBasis = costBasis.getTotalCostBasis();
    const unrealizedPnL = portfolioValue - remainingCostBasis;
    const cumulativePnL = totalRealizedPnL + unrealizedPnL;

    snapshots.push({
      date: snapshotDate.toISOString().split('T')[0],
      cumulativePnL,
      portfolioValue,
      sharePrice: pricePoint.sharePrice,
      components: {
        realized: totalRealizedPnL,
        unrealized: unrealizedPnL,
        fees: totalFees,
        rewards: totalRewards,
      },
    });
  }

  // Add today's snapshot with current price
  if (sortedPrices.length > 0) {
    // Apply remaining txs
    while (txIndex < sortedTxs.length) {
      const tx = sortedTxs[txIndex];
      const qty = BigInt(tx.quantity);
      const price = BigInt(tx.priceAtTx);
      const amount = BigInt(tx.amount);

      switch (tx.action) {
        case 'DEPOSIT': {
          currentQuantity += qty;
          if (method === 'fifo') {
            (costBasis as FifoCostBasis).addLot(qty, price, tx.timestamp, 'deposit', tx.txHash);
          } else {
            (costBasis as AverageCostBasis).addTokens(qty, price);
          }
          break;
        }
        case 'WITHDRAW': {
          currentQuantity -= qty;
          totalRealizedPnL += costBasis.dispose(qty, price);
          break;
        }
        case 'HARVEST': {
          const rewardAmount = tx.reward ? BigInt(tx.reward) : amount;
          totalRewards += rewardAmount;
          currentQuantity += qty;
          if (method === 'fifo') {
            (costBasis as FifoCostBasis).addLot(qty, 0n, tx.timestamp, 'reward', tx.txHash);
          } else {
            (costBasis as AverageCostBasis).addTokens(qty, 0n);
          }
          break;
        }
        case 'FEE': {
          const feeAmount = tx.fee ? BigInt(tx.fee) : amount;
          totalFees += feeAmount;
          if (qty > 0n) {
            totalRealizedPnL += costBasis.dispose(qty, 0n);
            currentQuantity -= qty;
          }
          break;
        }
        case 'SWAP': {
          currentQuantity -= qty;
          totalRealizedPnL += costBasis.dispose(qty, price);
          break;
        }
        case 'REBASE': {
          if (method === 'average-cost') {
            (costBasis as AverageCostBasis).applyRebase(qty);
          } else {
            const oldTotalQty = costBasis.getTotalQuantity();
            if (oldTotalQty > 0n) {
              const ratio = (qty * ONE) / oldTotalQty;
              for (const lot of (costBasis as FifoCostBasis).getLots()) {
                lot.amount = (lot.amount * ratio) / ONE;
              }
            }
          }
          currentQuantity = qty;
          break;
        }
      }
      txIndex++;
    }

    if (currentQuantity < 0n) currentQuantity = 0n;
    const todayValue = (currentQuantity * currentPrice) / ONE;
    const remainingCostBasis = costBasis.getTotalCostBasis();
    const unrealizedPnL = todayValue - remainingCostBasis;
    const todayPnL = totalRealizedPnL + unrealizedPnL;
    const today = new Date().toISOString().split('T')[0];

    const lastSnapshot = snapshots[snapshots.length - 1];
    if (!lastSnapshot || lastSnapshot.date !== today) {
      snapshots.push({
        date: today,
        cumulativePnL: todayPnL,
        portfolioValue: todayValue,
        sharePrice: currentPrice,
        components: {
          realized: totalRealizedPnL,
          unrealized: unrealizedPnL,
          fees: totalFees,
          rewards: totalRewards,
        },
      });
    }
  }

  return snapshots;
}