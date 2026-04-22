/**
 * PnL Engine — Historical Profit & Loss Calculation
 *
 * Calculates a user's true historical PnL by aggregating all deposits,
 * withdrawals and current share prices. Computes both Time-Weighted Return
 * (TWR) and absolute profit in USDC.
 */

export interface UserTransaction {
  action: "DEPOSIT" | "WITHDRAW";
  amount: number;
  shares: number;
  sharePriceAtTx: number;
  timestamp: Date;
}

export interface SharePriceSnapshot {
  sharePrice: number;
  snapshotAt: Date;
}

export interface PnLResult {
  /** Total amount deposited (in USDC). */
  totalDeposited: number;
  /** Total amount withdrawn (in USDC). */
  totalWithdrawn: number;
  /** Current value of remaining shares (in USDC). */
  currentValue: number;
  /** Net cost basis (deposits - withdrawals). */
  costBasis: number;
  /** Absolute profit/loss in USDC. */
  absolutePnL: number;
  /** Time-Weighted Return as a percentage. */
  twrPercent: number;
  /** Daily PnL snapshots for chart rendering. */
  dailySnapshots: DailyPnLSnapshot[];
}

export interface DailyPnLSnapshot {
  date: string;
  cumulativePnL: number;
  portfolioValue: number;
  sharePrice: number;
}

/**
 * Calculate the Time-Weighted Return (TWR) for a user.
 *
 * TWR eliminates the effect of external cash flows (deposits/withdrawals)
 * by breaking the period into sub-periods at each cash flow event and
 * compounding the sub-period returns.
 *
 * @param transactions  - Sorted array of user transactions (oldest first).
 * @param priceHistory  - Sorted array of daily share price snapshots.
 * @param currentPrice  - The current share price.
 * @returns Time-weighted return as a decimal (e.g. 0.12 = 12%).
 */
export function calculateTWR(
  transactions: UserTransaction[],
  priceHistory: SharePriceSnapshot[],
  currentPrice: number,
): number {
  if (transactions.length === 0 || currentPrice <= 0) {
    return 0;
  }

  const sorted = [...transactions].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  let compoundReturn = 1.0;
  let currentShares = 0;
  let previousValue = 0;

  for (const tx of sorted) {
    // Current portfolio value BEFORE this transaction
    const valueBeforeTx = currentShares * tx.sharePriceAtTx;

    // If we had a previous position, compute sub-period return
    if (previousValue > 0) {
      const subReturn = valueBeforeTx / previousValue;
      compoundReturn *= subReturn;
    }

    // Apply the transaction
    if (tx.action === "DEPOSIT") {
      currentShares += tx.shares;
    } else {
      currentShares -= tx.shares;
    }

    // Portfolio value AFTER this transaction
    previousValue = currentShares * tx.sharePriceAtTx;
  }

  // Final sub-period return (last tx to current price)
  if (previousValue > 0 && currentShares > 0) {
    const finalValue = currentShares * currentPrice;
    compoundReturn *= finalValue / previousValue;
  }

  return compoundReturn - 1.0;
}

/**
 * Calculate the full PnL for a user.
 *
 * @param transactions  - All user transactions (unsorted, will be sorted).
 * @param priceHistory  - Daily share price snapshots (unsorted, will be sorted).
 * @param currentPrice  - The current share price.
 * @returns Complete PnL result with daily snapshots for charting.
 */
export function calculatePnL(
  transactions: UserTransaction[],
  priceHistory: SharePriceSnapshot[],
  currentPrice: number,
): PnLResult {
  if (transactions.length === 0) {
    return {
      totalDeposited: 0,
      totalWithdrawn: 0,
      currentValue: 0,
      costBasis: 0,
      absolutePnL: 0,
      twrPercent: 0,
      dailySnapshots: [],
    };
  }

  const sorted = [...transactions].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const sortedPrices = [...priceHistory].sort(
    (a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime(),
  );

  // Aggregate totals
  let totalDeposited = 0;
  let totalWithdrawn = 0;
  let currentShares = 0;

  for (const tx of sorted) {
    if (tx.action === "DEPOSIT") {
      totalDeposited += tx.amount;
      currentShares += tx.shares;
    } else {
      totalWithdrawn += tx.amount;
      currentShares -= tx.shares;
    }
  }

  // Ensure no negative shares from rounding
  currentShares = Math.max(0, currentShares);

  const currentValue = roundUsd(currentShares * currentPrice);
  const costBasis = roundUsd(totalDeposited - totalWithdrawn);
  const absolutePnL = roundUsd(currentValue - costBasis);
  const twrPercent = roundPercent(
    calculateTWR(sorted, sortedPrices, currentPrice) * 100,
  );

  // Generate daily snapshots for charting
  const dailySnapshots = generateDailySnapshots(
    sorted,
    sortedPrices,
    currentPrice,
  );

  return {
    totalDeposited: roundUsd(totalDeposited),
    totalWithdrawn: roundUsd(totalWithdrawn),
    currentValue,
    costBasis,
    absolutePnL,
    twrPercent,
    dailySnapshots,
  };
}

/**
 * Generate daily PnL snapshots by replaying transactions against
 * the share price history.
 */
function generateDailySnapshots(
  sortedTxs: UserTransaction[],
  sortedPrices: SharePriceSnapshot[],
  currentPrice: number,
): DailyPnLSnapshot[] {
  if (sortedPrices.length === 0) return [];

  const snapshots: DailyPnLSnapshot[] = [];
  let txIndex = 0;
  let shares = 0;
  let totalCostBasis = 0;

  for (const pricePoint of sortedPrices) {
    const snapshotDate = pricePoint.snapshotAt;

    // Apply all transactions up to this snapshot date
    while (
      txIndex < sortedTxs.length &&
      sortedTxs[txIndex].timestamp <= snapshotDate
    ) {
      const tx = sortedTxs[txIndex];
      if (tx.action === "DEPOSIT") {
        shares += tx.shares;
        totalCostBasis += tx.amount;
      } else {
        shares -= tx.shares;
        totalCostBasis -= tx.amount;
      }
      txIndex++;
    }

    shares = Math.max(0, shares);
    const portfolioValue = roundUsd(shares * pricePoint.sharePrice);
    const cumulativePnL = roundUsd(portfolioValue - totalCostBasis);

    snapshots.push({
      date: snapshotDate.toISOString().split("T")[0],
      cumulativePnL,
      portfolioValue,
      sharePrice: pricePoint.sharePrice,
    });
  }

  // Add today's snapshot with current price
  if (sortedPrices.length > 0) {
    // Apply remaining txs
    while (txIndex < sortedTxs.length) {
      const tx = sortedTxs[txIndex];
      if (tx.action === "DEPOSIT") {
        shares += tx.shares;
        totalCostBasis += tx.amount;
      } else {
        shares -= tx.shares;
        totalCostBasis -= tx.amount;
      }
      txIndex++;
    }

    shares = Math.max(0, shares);
    const todayValue = roundUsd(shares * currentPrice);
    const todayPnL = roundUsd(todayValue - totalCostBasis);
    const today = new Date().toISOString().split("T")[0];

    const lastSnapshot = snapshots[snapshots.length - 1];
    if (!lastSnapshot || lastSnapshot.date !== today) {
      snapshots.push({
        date: today,
        cumulativePnL: todayPnL,
        portfolioValue: todayValue,
        sharePrice: currentPrice,
      });
    }
  }

  return snapshots;
}

/** Round to 2 decimal places for USD amounts. */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round to 2 decimal places for percentages. */
function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
