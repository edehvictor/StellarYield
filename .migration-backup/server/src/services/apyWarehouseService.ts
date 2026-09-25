import { connectToDatabase } from "../db/database";
import { ApySnapshotModel, type IApySnapshot } from "../models/ApySnapshot";

export interface ApySnapshotInput {
  protocolId: string;
  apy: number;
  tvl: number;
  timestamp: Date;
  source: string;
}

export interface RollupBucket {
  bucket: string; // ISO date string representing the bucket start
  avgApy: number;
  count: number;
}

/**
 * Store a single APY snapshot. Idempotent: if a snapshot for the same
 * protocolId + timestamp already exists, the existing record is returned
 * without creating a duplicate.
 */
export async function ingestSnapshot(
  data: ApySnapshotInput,
): Promise<IApySnapshot> {
  await connectToDatabase();

  const existing = await ApySnapshotModel.findOne({
    protocolId: data.protocolId,
    timestamp: data.timestamp,
  });

  if (existing) {
    // `.toObject()` is available on Mongoose documents; plain objects (e.g.
    // from `.lean()` calls or test mocks) do not have it — handle both cases.
    return (typeof (existing as { toObject?: () => IApySnapshot }).toObject === "function"
      ? (existing as { toObject: () => IApySnapshot }).toObject()
      : existing) as IApySnapshot;
  }

  const doc = await ApySnapshotModel.create(data);
  return (typeof (doc as { toObject?: () => IApySnapshot }).toObject === "function"
    ? (doc as { toObject: () => IApySnapshot }).toObject()
    : doc) as IApySnapshot;
}

/**
 * Return average APY per hour for a protocol within [from, to].
 */
export async function getHourlyRollup(
  protocolId: string,
  from: Date,
  to: Date,
): Promise<RollupBucket[]> {
  await connectToDatabase();

  const results = await ApySnapshotModel.aggregate<{
    _id: { year: number; month: number; day: number; hour: number };
    avgApy: number;
    count: number;
  }>([
    {
      $match: {
        protocolId,
        timestamp: { $gte: from, $lte: to },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$timestamp" },
          month: { $month: "$timestamp" },
          day: { $dayOfMonth: "$timestamp" },
          hour: { $hour: "$timestamp" },
        },
        avgApy: { $avg: "$apy" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1, "_id.hour": 1 } },
  ]);

  return results.map((r) => ({
    bucket: new Date(
      r._id.year,
      r._id.month - 1,
      r._id.day,
      r._id.hour,
    ).toISOString(),
    avgApy: r.avgApy,
    count: r.count,
  }));
}

/**
 * Return average APY per day for a protocol within [from, to].
 */
export async function getDailyRollup(
  protocolId: string,
  from: Date,
  to: Date,
): Promise<RollupBucket[]> {
  await connectToDatabase();

  const results = await ApySnapshotModel.aggregate<{
    _id: { year: number; month: number; day: number };
    avgApy: number;
    count: number;
  }>([
    {
      $match: {
        protocolId,
        timestamp: { $gte: from, $lte: to },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$timestamp" },
          month: { $month: "$timestamp" },
          day: { $dayOfMonth: "$timestamp" },
        },
        avgApy: { $avg: "$apy" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
  ]);

  return results.map((r) => ({
    bucket: new Date(r._id.year, r._id.month - 1, r._id.day).toISOString(),
    avgApy: r.avgApy,
    count: r.count,
  }));
}

/**
 * Return raw snapshots for a protocol within [from, to], ordered by timestamp asc.
 */
export async function getRange(
  protocolId: string,
  from: Date,
  to: Date,
): Promise<IApySnapshot[]> {
  await connectToDatabase();

  const docs = await ApySnapshotModel.find({
    protocolId,
    timestamp: { $gte: from, $lte: to },
  })
    .sort({ timestamp: 1 })
    .lean();

  return docs as IApySnapshot[];
}
