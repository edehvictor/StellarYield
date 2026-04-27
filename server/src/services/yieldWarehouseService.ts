import cron from "node-cron";
import { connectToDatabase } from "../db/database";
import {
  YieldSnapshotModel,
  HourlyRollupModel,
  DailyRollupModel,
  type IYieldSnapshot,
  type IHourlyRollup,
  type IDailyRollup,
} from "../models/YieldSnapshot";
import { getYieldData } from "./yieldService";

export async function ingestYieldSnapshots(): Promise<number> {
  const db = await connectToDatabase();
  if (!db) {
    console.warn("Skipping yield snapshot ingestion: no database connection");
    return 0;
  }

  const yields = await getYieldData();
  const snapshotAt = new Date();

  const existingSnapshots = await YieldSnapshotModel.find({
    snapshotAt: {
      $gte: new Date(snapshotAt.getTime() - 60000),
      $lte: snapshotAt,
    },
  }).lean();

  if (existingSnapshots.length > 0) {
    console.log(
      `[yield-warehouse] Skipping ingestion: ${existingSnapshots.length} snapshots already exist for this minute`,
    );
    return 0;
  }

  const snapshots: IYieldSnapshot[] = yields.map((yieldData) => ({
    protocolName: yieldData.protocolName,
    apy: yieldData.apy,
    tvl: yieldData.tvl,
    riskScore: yieldData.riskScore,
    source: yieldData.source,
    fetchedAt: new Date(yieldData.fetchedAt),
    snapshotAt,
  }));

  await YieldSnapshotModel.insertMany(snapshots);

  console.log(
    `[yield-warehouse] Ingested ${snapshots.length} yield snapshots at ${snapshotAt.toISOString()}`,
  );

  return snapshots.length;
}

export async function computeHourlyRollups(
  targetHour?: Date,
): Promise<number> {
  const db = await connectToDatabase();
  if (!db) {
    return 0;
  }

  const hourStart = targetHour || new Date();
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart);
  hourEnd.setHours(hourEnd.getHours() + 1);

  const snapshots = await YieldSnapshotModel.find({
    snapshotAt: { $gte: hourStart, $lt: hourEnd },
  }).lean();

  if (snapshots.length === 0) {
    return 0;
  }

  const byProtocol = new Map<string, IYieldSnapshot[]>();
  for (const snapshot of snapshots) {
    const protocolGroup = byProtocol.get(snapshot.protocolName) || [];
    protocolGroup.push(snapshot);
    byProtocol.set(snapshot.protocolName, protocolGroup);
  }

  const rollups: IHourlyRollup[] = [];
  for (const [protocolName, protocolSnapshots] of byProtocol) {
    const apyValues = protocolSnapshots.map((s) => s.apy);
    const tvlValues = protocolSnapshots.map((s) => s.tvl);

    const rollup: IHourlyRollup = {
      protocolName,
      hourStart,
      avgApy: apyValues.reduce((a, b) => a + b, 0) / apyValues.length,
      minApy: Math.min(...apyValues),
      maxApy: Math.max(...apyValues),
      avgTvl: tvlValues.reduce((a, b) => a + b, 0) / tvlValues.length,
      sampleCount: protocolSnapshots.length,
      createdAt: new Date(),
    };

    await HourlyRollupModel.findOneAndUpdate(
      { protocolName, hourStart },
      rollup,
      { upsert: true },
    );

    rollups.push(rollup);
  }

  console.log(
    `[yield-warehouse] Computed ${rollups.length} hourly rollups for ${hourStart.toISOString()}`,
  );

  return rollups.length;
}

export async function computeDailyRollups(targetDate?: Date): Promise<number> {
  const db = await connectToDatabase();
  if (!db) {
    return 0;
  }

  const date = targetDate || new Date();
  date.setHours(0, 0, 0, 0);
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + 1);

  const hourlyRollups = await HourlyRollupModel.find({
    hourStart: { $gte: date, $lt: nextDate },
  }).lean();

  if (hourlyRollups.length === 0) {
    return 0;
  }

  const byProtocol = new Map<string, IHourlyRollup[]>();
  for (const rollup of hourlyRollups) {
    const protocolGroup = byProtocol.get(rollup.protocolName) || [];
    protocolGroup.push(rollup);
    byProtocol.set(rollup.protocolName, protocolGroup);
  }

  const dailyRollups: IDailyRollup[] = [];
  for (const [protocolName, protocolRollups] of byProtocol) {
    const apyValues = protocolRollups.map((r) => r.avgApy);
    const meanApy = apyValues.reduce((a, b) => a + b, 0) / apyValues.length;
    const variance =
      apyValues.reduce((sum, apy) => sum + Math.pow(apy - meanApy, 2), 0) /
      apyValues.length;
    const stdDevApy = Math.sqrt(variance);

    const rollup: IDailyRollup = {
      protocolName,
      date,
      avgApy: meanApy,
      minApy: Math.min(...apyValues),
      maxApy: Math.max(...apyValues),
      stdDevApy,
      avgTvl:
        protocolRollups.reduce((sum, r) => sum + r.avgTvl, 0) /
        protocolRollups.length,
      totalSampleCount: protocolRollups.reduce(
        (sum, r) => sum + r.sampleCount,
        0,
      ),
      createdAt: new Date(),
    };

    await DailyRollupModel.findOneAndUpdate(
      { protocolName, date },
      rollup,
      { upsert: true },
    );

    dailyRollups.push(rollup);
  }

  console.log(
    `[yield-warehouse] Computed ${dailyRollups.length} daily rollups for ${date.toISOString()}`,
  );

  return dailyRollups.length;
}

export interface HistoricalRangeParams {
  protocol?: string;
  startDate: Date;
  endDate: Date;
  granularity: "hourly" | "daily";
  limit?: number;
}

export async function getHistoricalRange(
  params: HistoricalRangeParams,
): Promise<(IHourlyRollup | IDailyRollup)[]> {
  const db = await connectToDatabase();
  if (!db) {
    return [];
  }

  const { protocol, startDate, endDate, granularity, limit = 1000 } = params;

  if (granularity === "hourly") {
    const query: Record<string, unknown> = {
      hourStart: { $gte: startDate, $lte: endDate },
    };
    if (protocol) {
      query.protocolName = protocol;
    }

    const hourlyQuery = HourlyRollupModel.find(query) as unknown;
    const sortedHourlyQuery =
      typeof (hourlyQuery as any).sort === "function"
        ? (hourlyQuery as any).sort({ hourStart: -1 })
        : hourlyQuery;
    const limitedHourlyQuery =
      typeof (sortedHourlyQuery as any).limit === "function"
        ? (sortedHourlyQuery as any).limit(limit)
        : sortedHourlyQuery;

    return typeof (limitedHourlyQuery as any).lean === "function"
      ? (limitedHourlyQuery as any).lean()
      : (limitedHourlyQuery as Promise<IHourlyRollup[]>);
  }

  const query: Record<string, unknown> = {
    date: { $gte: startDate, $lte: endDate },
  };
  if (protocol) {
    query.protocolName = protocol;
  }

  const dailyQuery = DailyRollupModel.find(query) as unknown;
  const sortedDailyQuery =
    typeof (dailyQuery as any).sort === "function"
      ? (dailyQuery as any).sort({ date: -1 })
      : dailyQuery;
  const limitedDailyQuery =
    typeof (sortedDailyQuery as any).limit === "function"
      ? (sortedDailyQuery as any).limit(limit)
      : sortedDailyQuery;

  return typeof (limitedDailyQuery as any).lean === "function"
    ? (limitedDailyQuery as any).lean()
    : (limitedDailyQuery as Promise<IDailyRollup[]>);
}

export async function getProtocolStats(
  protocolName: string,
): Promise<{
  currentApy: number;
  avgApy7d: number;
  avgApy30d: number;
  volatility30d: number;
  tvl: number;
} | null> {
  const db = await connectToDatabase();
  if (!db) {
    return null;
  }

  const yields = await getYieldData();
  const currentYield = yields.find(
    (y) => y.protocolName.toLowerCase() === protocolName.toLowerCase(),
  );

  const now = new Date();
  const day7 = new Date(now);
  day7.setDate(day7.getDate() - 7);
  const day30 = new Date(now);
  day30.setDate(day30.getDate() - 30);

  const rollups7d = await DailyRollupModel.find({
    protocolName,
    date: { $gte: day7 },
  }).lean();

  const rollups30d = await DailyRollupModel.find({
    protocolName,
    date: { $gte: day30 },
  }).lean();

  const avgApy7d =
    rollups7d.length > 0
      ? rollups7d.reduce((sum, r) => sum + r.avgApy, 0) / rollups7d.length
      : 0;

  const avgApy30d =
    rollups30d.length > 0
      ? rollups30d.reduce((sum, r) => sum + r.avgApy, 0) / rollups30d.length
      : 0;

  const volatility30d =
    rollups30d.length > 0
      ? rollups30d.reduce((sum, r) => sum + r.stdDevApy, 0) / rollups30d.length
      : 0;

  return {
    currentApy: currentYield?.apy || 0,
    avgApy7d,
    avgApy30d,
    volatility30d,
    tvl: currentYield?.tvl || 0,
  };
}

export function startYieldWarehouseJobs(): void {
  cron.schedule("* * * * *", () => {
    void ingestYieldSnapshots();
  });

  cron.schedule("15 * * * *", () => {
    const hourStart = new Date();
    hourStart.setHours(hourStart.getHours() - 1);
    hourStart.setMinutes(0, 0, 0);
    void computeHourlyRollups(hourStart);
  });

  cron.schedule("30 1 * * *", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    void computeDailyRollups(yesterday);
  });

  console.info(
    "[yield-warehouse] Scheduled jobs: snapshots (hourly), hourly rollups (15 past hour), daily rollups (1:30 AM)",
  );
}