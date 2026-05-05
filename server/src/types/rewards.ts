export type RewardEventType = 'START' | 'END' | 'CLIFF' | 'TAPER_START' | 'TAPER_END';

export interface RewardEvent {
  type: RewardEventType;
  date: Date;
  metadata?: Record<string, any>;
}

export interface RewardSchedule {
  protocolName: string;
  tokenSymbol: string;
  dailyEmission: number;
  startDate: Date;
  endDate: Date;
  cliffDate?: Date;
  taperStartDate?: Date;
  taperEndDate?: Date;
  taperRate?: number; 
  sourceProvenance: string;
  confidence: "low" | "medium" | "high";
  isActive: boolean;
  events: RewardEvent[];
}
