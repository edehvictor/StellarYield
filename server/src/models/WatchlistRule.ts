import { Schema, model, models } from "mongoose";

export interface WatchlistRule {
  id: string;
  userId: string;
  targetType: "protocol" | "pool" | "strategy";
  targetId: string;
  targetName: string;
  conditions: WatchlistCondition[];
  notificationChannels: ("email" | "webhook" | "push")[];
  status: "active" | "paused" | "triggered";
  lastTriggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WatchlistCondition {
  metric: "apy" | "tvl" | "spread";
  operator: "above" | "below" | "change_above";
  value: number;
  cooldownMinutes: number;
}

const WatchlistRuleSchema = new Schema<WatchlistRule>(
  {
    userId: { type: String, required: true, index: true },
    targetType: {
      type: String,
      enum: ["protocol", "pool", "strategy"],
      required: true,
    },
    targetId: { type: String, required: true },
    targetName: { type: String, required: true },
    conditions: [
      {
        metric: {
          type: String,
          enum: ["apy", "tvl", "spread"],
          required: true,
        },
        operator: {
          type: String,
          enum: ["above", "below", "change_above"],
          required: true,
        },
        value: { type: Number, required: true },
        cooldownMinutes: { type: Number, default: 60 },
      },
    ],
    notificationChannels: [
      {
        type: String,
        enum: ["email", "webhook", "push"],
      },
    ],
    status: {
      type: String,
      enum: ["active", "paused", "triggered"],
      default: "active",
    },
    lastTriggeredAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  },
);

WatchlistRuleSchema.index({ userId: 1, status: 1 });
WatchlistRuleSchema.index({ userId: 1, targetId: 1 }, { unique: true });

export const WatchlistRuleModel =
  models.WatchlistRule || model("WatchlistRule", WatchlistRuleSchema);