#!/usr/bin/env ts-node
/**
 * Local development seed script (#182).
 *
 * Populates the database with deterministic sample data so new contributors
 * can run the backend with realistic yields, portfolios, leaderboard entries,
 * and notifications without production credentials.
 *
 * Usage:
 *   npx ts-node server/scripts/seed.ts
 *   # or via npm script:
 *   npm run seed --prefix server
 *
 * Safe to rerun — upserts are used throughout so no duplicate rows accumulate.
 *
 * Required env:
 *   DATABASE_URL  — Postgres connection string (same as dev server)
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Deterministic seed addresses (not real funded accounts)
const SEED_WALLETS = [
  "GDETESTWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "GDETESTWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "GDETESTWALLETCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
];

const VAULT_IDS = ["vault-usdc-testnet", "vault-xlm-testnet", "vault-aqua-testnet"];

async function seedIndexerState() {
  await prisma.indexerState.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton", lastLedger: 1_000_000 },
  });
  console.log("  ✓ indexerState");
}

async function seedVaultBalances() {
  const balances = SEED_WALLETS.map((addr, i) => ({
    walletAddress: addr,
    tvl: 1000 * (i + 1),
    totalYield: 50 * (i + 1),
  }));

  for (const b of balances) {
    await prisma.vaultBalance.upsert({
      where: { walletAddress: b.walletAddress },
      update: { tvl: b.tvl, totalYield: b.totalYield },
      create: b,
    });
  }
  console.log("  ✓ vaultBalances");
}

async function seedNotifications() {
  const types = ["DEPOSIT", "WITHDRAWAL", "HARVEST", "ANNOUNCEMENT"] as const;
  const messages: Record<(typeof types)[number], { title: string; message: string }> = {
    DEPOSIT: {
      title: "Deposit confirmed",
      message: "Your deposit of 100 USDC was confirmed on-chain.",
    },
    WITHDRAWAL: {
      title: "Withdrawal processed",
      message: "50 USDC has been returned to your wallet.",
    },
    HARVEST: {
      title: "Yield harvested",
      message: "12.5 USDC in yield was harvested and compounded.",
    },
    ANNOUNCEMENT: {
      title: "New vault available",
      message: "The AQUA/USDC vault is now live on testnet.",
    },
  };

  for (const wallet of SEED_WALLETS) {
    for (const type of types) {
      const { title, message } = messages[type];
      await prisma.notification.create({
        data: { walletAddress: wallet, type, title, message },
      });
    }
  }
  console.log("  ✓ notifications");
}

async function seedSharePriceSnapshots() {
  const now = new Date();
  for (const vaultId of VAULT_IDS) {
    for (let i = 29; i >= 0; i--) {
      const snapshotAt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const basePrice = vaultId === "vault-usdc-testnet" ? 1.0 : 0.12;
      await prisma.sharePriceSnapshot.create({
        data: {
          vaultId,
          sharePrice: parseFloat((basePrice * (1 + i * 0.0005)).toFixed(6)),
          totalShares: 100_000,
          totalAssets: 100_000 * basePrice,
          snapshotAt,
        },
      });
    }
  }
  console.log("  ✓ sharePriceSnapshots (30 days × 3 vaults)");
}

async function seedUserTransactions() {
  for (const wallet of SEED_WALLETS) {
    const vaultId = VAULT_IDS[0];
    await prisma.userTransaction.upsert({
      where: { txHash: `seed-deposit-${wallet.slice(-4)}` },
      update: {},
      create: {
        walletAddress: wallet,
        vaultId,
        action: "DEPOSIT",
        amount: 500,
        shares: 500,
        sharePriceAtTx: 1.0,
        txHash: `seed-deposit-${wallet.slice(-4)}`,
        timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.userTransaction.upsert({
      where: { txHash: `seed-harvest-${wallet.slice(-4)}` },
      update: {},
      create: {
        walletAddress: wallet,
        vaultId,
        action: "HARVEST",
        amount: 12.5,
        shares: 0,
        sharePriceAtTx: 1.025,
        txHash: `seed-harvest-${wallet.slice(-4)}`,
        timestamp: new Date(),
      },
    });
  }
  console.log("  ✓ userTransactions");
}

async function seedAlerts() {
  for (const wallet of SEED_WALLETS) {
    await prisma.userAlert.create({
      data: {
        walletAddress: wallet,
        vaultId: VAULT_IDS[0],
        condition: "above",
        thresholdValue: 10.0,
        email: `dev+${wallet.slice(-4).toLowerCase()}@example.com`,
      },
    });
  }
  console.log("  ✓ userAlerts");
}

async function main() {
  console.log("🌱 Seeding development database...");

  await seedIndexerState();
  await seedVaultBalances();
  await seedNotifications();
  await seedSharePriceSnapshots();
  await seedUserTransactions();
  await seedAlerts();

  console.log("\n✅ Seed complete. Run `npm run dev` in server/ to start the backend.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
