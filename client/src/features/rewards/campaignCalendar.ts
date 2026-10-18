export interface RewardCampaign {
  protocolName: string;
  tokenSymbol: string;
  dailyEmission: number;
  startDate: string;
  endDate: string;
  isActive: boolean;
}

export interface CampaignOverlap {
  first: RewardCampaign;
  second: RewardCampaign;
}

function isRewardCampaign(entry: unknown): entry is RewardCampaign {
  if (entry === null || typeof entry !== "object") return false;
  const campaign = entry as Record<string, unknown>;
  return (
    typeof campaign.protocolName === "string" &&
    campaign.protocolName.trim().length > 0 &&
    typeof campaign.tokenSymbol === "string" &&
    campaign.tokenSymbol.trim().length > 0 &&
    typeof campaign.dailyEmission === "number" &&
    Number.isFinite(campaign.dailyEmission) &&
    typeof campaign.startDate === "string" &&
    Number.isFinite(Date.parse(campaign.startDate)) &&
    typeof campaign.endDate === "string" &&
    Number.isFinite(Date.parse(campaign.endDate)) &&
    Date.parse(campaign.endDate) > Date.parse(campaign.startDate) &&
    typeof campaign.isActive === "boolean"
  );
}

export function parseRewardCampaigns(payload: unknown): RewardCampaign[] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { campaigns?: unknown }).campaigns)
  ) {
    throw new Error("Reward campaign calendar response is invalid.");
  }

  const campaigns = (payload as { campaigns: unknown[] }).campaigns;
  if (!campaigns.every(isRewardCampaign)) {
    throw new Error("Reward campaign calendar response is invalid.");
  }
  return campaigns;
}

export function findCampaignOverlaps(
  campaigns: RewardCampaign[],
): CampaignOverlap[] {
  const overlaps: CampaignOverlap[] = [];
  for (let firstIndex = 0; firstIndex < campaigns.length; firstIndex += 1) {
    const first = campaigns[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < campaigns.length;
      secondIndex += 1
    ) {
      const second = campaigns[secondIndex];
      if (
        first.isActive &&
        second.isActive &&
        first.protocolName === second.protocolName &&
        first.tokenSymbol === second.tokenSymbol &&
        Date.parse(first.startDate) < Date.parse(second.endDate) &&
        Date.parse(second.startDate) < Date.parse(first.endDate)
      ) {
        overlaps.push({ first, second });
      }
    }
  }
  return overlaps;
}

export function getCalendarDays(year: number, month: number): Date[] {
  const firstDay = new Date(Date.UTC(year, month, 1));
  const mondayOffset = (firstDay.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dayCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;

  return Array.from({ length: dayCount }, (_, index) =>
    new Date(Date.UTC(year, month, index - mondayOffset + 1)),
  );
}

export function campaignIncludesCalendarDay(
  campaign: RewardCampaign,
  day: Date,
): boolean {
  const dayStart = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
  );
  const nextDay = dayStart + 24 * 60 * 60 * 1000;
  return Date.parse(campaign.startDate) < nextDay &&
    Date.parse(campaign.endDate) > dayStart;
}
