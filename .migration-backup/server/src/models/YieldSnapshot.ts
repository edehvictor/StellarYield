import { Schema, model, models } from "mongoose";

const YieldSnapshotSchema = new Schema(
  {
    protocolName: { type: String, required: true },
    apy: { type: Number, required: true },
    tvl: { type: Number, required: true },
    riskScore: { type: Number, required: true },
    source: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    snapshotAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  },
);

export const YieldSnapshotModel =
  models.YieldSnapshot || model("YieldSnapshot", YieldSnapshotSchema);
