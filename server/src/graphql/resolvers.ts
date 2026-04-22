import type { GraphQLContext } from "./context";

type ResolverContext = GraphQLContext;

const toUserId = (walletAddress: string) => walletAddress;

export const resolvers = {
  Query: {
    vault: async (_: unknown, args: { id: string }, ctx: ResolverContext) =>
      ctx.prisma.vaultBalance.findUnique({ where: { id: args.id } }),
    vaults: async (_: unknown, args: { limit?: number }, ctx: ResolverContext) =>
      ctx.prisma.vaultBalance.findMany({
        take: Math.min(args.limit ?? 50, 100),
        orderBy: { updatedAt: "desc" },
      }),
    user: async (
      _: unknown,
      args: { walletAddress: string },
      _ctx: ResolverContext,
    ) => ({ id: toUserId(args.walletAddress), walletAddress: args.walletAddress }),
    users: async (_: unknown, args: { limit?: number }, ctx: ResolverContext) => {
      const rows = await ctx.prisma.vaultBalance.findMany({
        take: Math.min(args.limit ?? 50, 100),
        orderBy: { updatedAt: "desc" },
      });
      return rows.map((row) => ({ id: toUserId(row.walletAddress), walletAddress: row.walletAddress }));
    },
    transactions: async (
      _: unknown,
      args: { walletAddress?: string; limit?: number },
      ctx: ResolverContext,
    ) =>
      ctx.prisma.onRampTransaction.findMany({
        where: args.walletAddress ? { walletAddress: args.walletAddress } : undefined,
        take: Math.min(args.limit ?? 50, 100),
        orderBy: { createdAt: "desc" },
      }),
    yieldSnapshots: async (
      _: unknown,
      args: { protocolName?: string; limit?: number },
      ctx: ResolverContext,
    ) => {
      const docs = await ctx.yieldSnapshotModel
        .find(args.protocolName ? { protocolName: args.protocolName } : {})
        .sort({ snapshotAt: -1 })
        .limit(Math.min(args.limit ?? 50, 100))
        .lean()
        .exec();
      return docs.map((doc) => ({ ...doc, id: String(doc._id) }));
    },
  },
  User: {
    vault: async (
      user: { walletAddress: string },
      _: unknown,
      ctx: ResolverContext,
    ) => ctx.prisma.vaultBalance.findUnique({ where: { walletAddress: user.walletAddress } }),
    notifications: async (
      user: { walletAddress: string },
      args: { limit?: number },
      ctx: ResolverContext,
    ) =>
      ctx.prisma.notification.findMany({
        where: { walletAddress: user.walletAddress },
        take: Math.min(args.limit ?? 20, 100),
        orderBy: { createdAt: "desc" },
      }),
    transactions: async (
      user: { walletAddress: string },
      args: { limit?: number },
      ctx: ResolverContext,
    ) =>
      ctx.prisma.onRampTransaction.findMany({
        where: { walletAddress: user.walletAddress },
        take: Math.min(args.limit ?? 20, 100),
        orderBy: { createdAt: "desc" },
      }),
  },
  Vault: {
    transactions: async (
      vault: { walletAddress: string },
      args: { limit?: number },
      ctx: ResolverContext,
    ) =>
      ctx.prisma.onRampTransaction.findMany({
        where: { walletAddress: vault.walletAddress },
        take: Math.min(args.limit ?? 20, 100),
        orderBy: { createdAt: "desc" },
      }),
    yieldSnapshots: async (
      _: { walletAddress: string },
      args: { limit?: number },
      ctx: ResolverContext,
    ) => {
      const docs = await ctx.yieldSnapshotModel
        .find({})
        .sort({ snapshotAt: -1 })
        .limit(Math.min(args.limit ?? 30, 100))
        .lean()
        .exec();
      return docs.map((doc) => ({ ...doc, id: String(doc._id) }));
    },
  },
};
