import { PrismaClient } from "@prisma/client";

import { YieldSnapshotModel } from "../models/YieldSnapshot";

export interface GraphQLContext {
  prisma: PrismaClient;
  yieldSnapshotModel: typeof YieldSnapshotModel;
}

export const prisma = new PrismaClient();

export const context: GraphQLContext = {
  prisma,
  yieldSnapshotModel: YieldSnapshotModel,
};
