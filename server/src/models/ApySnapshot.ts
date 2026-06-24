import { Schema, model, models } from "mongoose";

export interface IApySnapshot {
  protocolId: string;
  apy: number;
  tvl: number;
  timestamp: Date;
  source: string;
}

const ApySnapshotSchema = new Schema<IApySnapshot>(
  {
    protocolId: { type: String, required: true },
    apy: { type: Number, required: true },
    tvl: { type: Number, required: true },
    timestamp: { type: Date, required: true },
    source: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

// Compound unique index to enforce idempotency on protocolId + timestamp
ApySnapshotSchema.index({ protocolId: 1, timestamp: 1 }, { unique: true });

// Index to speed up range queries
ApySnapshotSchema.index({ protocolId: 1, timestamp: -1 });

export const ApySnapshotModel =
  models.ApySnapshot || model<IApySnapshot>("ApySnapshot", ApySnapshotSchema);
