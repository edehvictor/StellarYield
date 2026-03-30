import cron from "node-cron";

/**
 * Daily Share Price Snapshot Job
 *
 * Runs once per day at midnight UTC to capture the current vault share
 * price and store it for PnL calculations.
 */

type PrismaLike = {
  sharePriceSnapshot: {
    create(args: {
      data: {
        vaultId: string;
        sharePrice: number;
        totalShares: number;
        totalAssets: number;
      };
    }): Promise<unknown>;
  };
  $disconnect?: () => Promise<void>;
};

async function loadPrismaClient(): Promise<PrismaLike | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as {
      PrismaClient?: new () => PrismaLike;
    };
    if (!prismaModule.PrismaClient) return null;
    return new prismaModule.PrismaClient();
  } catch {
    console.warn("[share-price-job] Prisma client unavailable.");
    return null;
  }
}

/**
 * Fetch current vault metrics. In production, this would query the
 * Soroban contract for total_shares and total_assets.
 */
async function fetchVaultMetrics(): Promise<{
  vaultId: string;
  totalShares: number;
  totalAssets: number;
}> {
  // Simulated vault data — in production, query the Soroban contract
  return {
    vaultId: "primary-yield-vault",
    totalShares: 1_000_000,
    totalAssets: 1_050_000,
  };
}

export async function runSharePriceSnapshot(): Promise<void> {
  try {
    const prisma = await loadPrismaClient();

    if (!prisma) {
      console.warn(
        "[share-price-job] Skipping snapshot — no database connection.",
      );
      return;
    }

    const vault = await fetchVaultMetrics();
    const sharePrice =
      vault.totalShares > 0 ? vault.totalAssets / vault.totalShares : 1.0;

    await prisma.sharePriceSnapshot.create({
      data: {
        vaultId: vault.vaultId,
        sharePrice,
        totalShares: vault.totalShares,
        totalAssets: vault.totalAssets,
      },
    });

    await prisma.$disconnect?.();

    console.info(
      `[share-price-job] Snapshot stored: price=${sharePrice.toFixed(6)}, ` +
        `shares=${vault.totalShares}, assets=${vault.totalAssets}`,
    );
  } catch (error) {
    console.error("[share-price-job] Snapshot run failed.", error);
  }
}

export function startSharePriceSnapshotJob(): void {
  // Run daily at 00:00 UTC
  cron.schedule("0 0 * * *", () => {
    void runSharePriceSnapshot();
  });

  console.info(
    "[share-price-job] Scheduled to run daily at 00:00 UTC.",
  );
}
