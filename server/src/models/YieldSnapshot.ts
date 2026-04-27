import { Schema, model, models } from "mongoose";

export interface IYieldSnapshot {
  protocolName: string;
  apy: number;
  tvl: number;
  riskScore: number;
  source: string;
  fetchedAt: Date;
  snapshotAt: Date;
  createdAt?: Date;
}

const YieldSnapshotSchema = new Schema<IYieldSnapshot>(
  {
    protocolName: { type: String, required: true, index: true },
    apy: { type: Number, required: true },
    tvl: { type: Number, required: true },
    riskScore: { type: Number, required: true },
    source: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    snapshotAt: { type: Date, required: true, index: true },
  },
  {
    timestamps: true,
  },
);

YieldSnapshotSchema.index({ protocolName: 1, snapshotAt: -1 });
YieldSnapshotSchema.index({ snapshotAt: -1 }, { unique: true });

export const YieldSnapshotModel =
  models.YieldSnapshot || model<IYieldSnapshot>("YieldSnapshot", YieldSnapshotSchema);

export interface IHourlyRollup {
  protocolName: string;
  hourStart: Date;
  avgApy: number;
  minApy: number;
  maxApy: number;
  avgTvl: number;
  sampleCount: number;
  createdAt: Date;
}

const HourlyRollupSchema = new Schema<IHourlyRollup>(
  {
    protocolName: { type: String, required: true, index: true },
    hourStart: { type: Date, required: true, index: true },
    avgApy: { type: Number, required: true },
    minApy: { type: Number, required: true },
    maxApy: { type: Number, required: true },
    avgTvl: { type: Number, required: true },
    sampleCount: { type: Number, required: true },
    createdAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  },
);

HourlyRollupSchema.index({ protocolName: 1, hourStart: -1 });
HourlyRollupSchema.index({ hourStart: -1 }, { unique: true });

export const HourlyRollupModel =
  models.HourlyRollup || model<IHourlyRollup>("HourlyRollup", HourlyRollupSchema);

export interface IDailyRollup {
  protocolName: string;
  date: Date;
  avgApy: number;
  minApy: number;
  maxApy: number;
  stdDevApy: number;
  avgTvl: number;
  totalSampleCount: number;
  createdAt: Date;
}

const DailyRollupSchema = new Schema<IDailyRollup>(
  {
    protocolName: { type: String, required: true, index: true },
    date: { type: Date, required: true, index: true },
    avgApy: { type: Number, required: true },
    minApy: { type: Number, required: true },
    maxApy: { type: Number, required: true },
    stdDevApy: { type: Number, required: true },
    avgTvl: { type: Number, required: true },
    totalSampleCount: { type: Number, required: true },
    createdAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  },
);

DailyRollupSchema.index({ protocolName: 1, date: -1 });
DailyRollupSchema.index({ date: -1 }, { unique: true });

export const DailyRollupModel =
  models.DailyRollup || model<IDailyRollup>("DailyRollup", DailyRollupSchema);
