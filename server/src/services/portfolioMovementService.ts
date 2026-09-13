import { PrismaClient } from "@prisma/client";
import { calculateDailyMovement, type DailyMovement } from "../../../shared/types/dailyMovement";
import type { UserTransaction } from "@prisma/client";

export class PortfolioMovementService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get daily portfolio movement for a wallet.
   * Compares today's snapshot against yesterday's.
   */
  async getDailyMovement(walletAddress: string): Promise<DailyMovement> {
    const today = this.getDateKey(new Date());
    const yesterday = this.getDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

    // Fetch today's and yesterday's snapshots
    const [currentSnapshot, previousSnapshot] = await Promise.all([
      this.prisma.dailyPortfolioSnapshot.findUnique({
        where: {
          walletAddress_snapshotDate: {
            walletAddress,
            snapshotDate: today,
          },
        },
      }),
      this.prisma.dailyPortfolioSnapshot.findUnique({
        where: {
          walletAddress_snapshotDate: {
            walletAddress,
            snapshotDate: yesterday,
          },
        },
      }),
    ]);

    if (!currentSnapshot) {
      // No current snapshot—return neutral state
      return {
        walletAddress,
        snapshotDate: today.toISOString().split('T')[0],
        previousSnapshotDate: undefined,
        previousTotalValue: 0,
        currentTotalValue: 0,
        totalAbsoluteChange: 0,
        totalPercentChange: 0,
        assetMovements: [],
        protocolMovements: [],
        depositedToday: 0,
        withdrawnToday: 0,
        priceMovementOnly: 0,
        hasPreviousSnapshot: false,
        isNegativeMovement: false,
      };
    }

    // Get today's transactions (deposits and withdrawals)
    const transactions = await this.getTodaysTransactions(walletAddress);

    // Calculate movement
    const movement = calculateDailyMovement(
      {
        walletAddress,
        totalValueUsd: currentSnapshot.totalValueUsd,
        assetBreakdown:
          (currentSnapshot.assetBreakdown as Record<
            string,
            { valueUsd: number; quantity: number }
          >) || {},
        protocolBreakdown:
          (currentSnapshot.protocolBreakdown as Record<
            string,
            { valueUsd: number }
          >) || {},
      },
      previousSnapshot
        ? {
            totalValueUsd: previousSnapshot.totalValueUsd,
            assetBreakdown:
              (previousSnapshot.assetBreakdown as Record<
                string,
                { valueUsd: number; quantity: number }
              >) || {},
            protocolBreakdown:
              (previousSnapshot.protocolBreakdown as Record<
                string,
                { valueUsd: number }
              >) || {},
          }
        : undefined,
      {
        deposited: transactions.deposited,
        withdrawn: transactions.withdrawn,
      },
    );

    return movement;
  }

  /**
   * Store a daily portfolio snapshot.
   * Called by keeper/indexer process at end of day.
   */
  async storeSnapshot(
    walletAddress: string,
    totalValueUsd: number,
    totalDepositedUsd: number,
    totalWithdrawnUsd: number,
    assetBreakdown: Record<string, { valueUsd: number; quantity: number }>,
    protocolBreakdown: Record<string, { valueUsd: number }>,
  ): Promise<void> {
    const snapshotDate = this.getDateKey(new Date());

    await this.prisma.dailyPortfolioSnapshot.upsert({
      where: {
        walletAddress_snapshotDate: {
          walletAddress,
          snapshotDate,
        },
      },
      update: {
        totalValueUsd,
        totalDepositedUsd,
        totalWithdrawnUsd,
        assetBreakdown,
        protocolBreakdown,
      },
      create: {
        walletAddress,
        snapshotDate,
        totalValueUsd,
        totalDepositedUsd,
        totalWithdrawnUsd,
        assetBreakdown,
        protocolBreakdown,
      },
    });
  }

  /**
   * Get multiple days of portfolio movement history.
   */
  async getMovementHistory(
    walletAddress: string,
    days: number = 30,
  ): Promise<DailyMovement[]> {
    const snapshots = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: { walletAddress },
      orderBy: { snapshotDate: "desc" },
      take: days,
    });

    const movements: DailyMovement[] = [];

    // Sort by date ascending for proper comparison
    snapshots.reverse();

    for (let i = 0; i < snapshots.length; i++) {
      const current = snapshots[i];
      const previous = i > 0 ? snapshots[i - 1] : undefined;

      const movement = calculateDailyMovement(
        {
          walletAddress,
          totalValueUsd: current.totalValueUsd,
          assetBreakdown:
            (current.assetBreakdown as Record<
              string,
              { valueUsd: number; quantity: number }
            >) || {},
          protocolBreakdown:
            (current.protocolBreakdown as Record<
              string,
              { valueUsd: number }
            >) || {},
        },
        previous
          ? {
              totalValueUsd: previous.totalValueUsd,
              assetBreakdown:
                (previous.assetBreakdown as Record<
                  string,
                  { valueUsd: number; quantity: number }
                >) || {},
              protocolBreakdown:
                (previous.protocolBreakdown as Record<
                  string,
                  { valueUsd: number }
                >) || {},
            }
          : undefined,
        {
          deposited: current.totalDepositedUsd - (previous?.totalDepositedUsd || 0),
          withdrawn: current.totalWithdrawnUsd - (previous?.totalWithdrawnUsd || 0),
        },
      );

      movements.push(movement);
    }

    return movements;
  }

  /**
   * Get today's deposit and withdrawal totals.
   */
  private async getTodaysTransactions(
    walletAddress: string,
  ): Promise<{ deposited: number; withdrawn: number }> {
    const today = this.getDateKey(new Date());
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    const transactions = await this.prisma.userTransaction.findMany({
      where: {
        walletAddress,
        timestamp: {
          gte: today,
          lt: tomorrow,
        },
      },
    });

    let deposited = 0;
    let withdrawn = 0;

    for (const tx of transactions) {
      if (tx.action === "DEPOSIT") {
        deposited += tx.amount || 0;
      } else if (tx.action === "WITHDRAW") {
        withdrawn += tx.amount || 0;
      }
    }

    return { deposited, withdrawn };
  }

  /**
   * Normalize a date to UTC start of day (YYYY-MM-DD).
   */
  private getDateKey(date: Date): Date {
    const normalized = new Date(date);
    normalized.setUTCHours(0, 0, 0, 0);
    return normalized;
  }
}
