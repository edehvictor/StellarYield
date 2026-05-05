import { Schema, model, models } from "mongoose";

export interface VaultRebalanceEvent {
  vaultId: string;
  vaultName: string;
  timestamp: Date;
  triggerReason: string;
  expectedOutcome: string;
  riskNote: string;
  beforeAllocations: AllocationBreakdown[];
  afterAllocations: AllocationBreakdown[];
  status: "pending" | "completed" | "failed";
}

export interface AllocationBreakdown {
  assetId: string;
  assetName: string;
  weight: number;
  value: number;
}

const VaultRebalanceEventSchema = new Schema<VaultRebalanceEvent>(
  {
    vaultId: { type: String, required: true, index: true },
    vaultName: { type: String, required: true },
    timestamp: { type: Date, required: true, index: true },
    triggerReason: { type: String, required: true },
    expectedOutcome: { type: String, required: true },
    riskNote: { type: String, default: "" },
    beforeAllocations: [
      {
        assetId: { type: String, required: true },
        assetName: { type: String, required: true },
        weight: { type: Number, required: true },
        value: { type: Number, required: true },
      },
    ],
    afterAllocations: [
      {
        assetId: { type: String, required: true },
        assetName: { type: String, required: true },
        weight: { type: Number, required: true },
        value: { type: Number, required: true },
      },
    ],
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "completed",
    },
  },
  {
    timestamps: false,
  },
);

VaultRebalanceEventSchema.index({ vaultId: 1, timestamp: -1 });

export const VaultRebalanceEventModel =
  models.VaultRebalanceEvent ||
  model("VaultRebalanceEvent", VaultRebalanceEventSchema);