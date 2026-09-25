import { Schema, model, models } from "mongoose";

const RewardEventSchema = new Schema({
  type: { 
    type: String, 
    enum: ['START', 'END', 'CLIFF', 'TAPER_START', 'TAPER_END'],
    required: true 
  },
  date: { type: Date, required: true },
  metadata: { type: Schema.Types.Mixed }
});

const RewardScheduleSchema = new Schema(
  {
    protocolName: { type: String, required: true, index: true },
    tokenSymbol: { type: String, required: true },
    dailyEmission: { type: Number, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    cliffDate: { type: Date },
    taperStartDate: { type: Date },
    taperEndDate: { type: Date },
    taperRate: { type: Number },
    sourceProvenance: { type: String, required: true },
    confidence: { 
      type: String, 
      enum: ["low", "medium", "high"], 
      required: true,
      default: "low"
    },
    isActive: { type: Boolean, default: true },
    events: [RewardEventSchema]
  },
  {
    timestamps: true,
  }
);

export const RewardScheduleModel =
  models.RewardSchedule || model("RewardSchedule", RewardScheduleSchema);
