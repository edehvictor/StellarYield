import { describe, expect, it } from "vitest";
import {
  campaignIncludesCalendarDay,
  findCampaignOverlaps,
  getCalendarDays,
  parseRewardCampaigns,
  type RewardCampaign,
} from "./campaignCalendar";

const campaign = (
  overrides: Partial<RewardCampaign> = {},
): RewardCampaign => ({
  protocolName: "Blend",
  tokenSymbol: "BLND",
  dailyEmission: 100,
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-06-10T00:00:00.000Z",
  isActive: true,
  ...overrides,
});

describe("reward campaign calendar helpers", () => {
  it("finds overlapping windows only for the same protocol and token", () => {
    const first = campaign();
    const second = campaign({
      startDate: "2026-06-05T00:00:00.000Z",
      endDate: "2026-06-15T00:00:00.000Z",
    });
    const backToBack = campaign({
      startDate: "2026-06-10T00:00:00.000Z",
      endDate: "2026-06-20T00:00:00.000Z",
    });
    const otherToken = campaign({
      tokenSymbol: "OTHER",
      startDate: second.startDate,
      endDate: second.endDate,
    });

    expect(findCampaignOverlaps([first, second, backToBack, otherToken])).toEqual([
      { first, second },
    ]);
    expect(
      findCampaignOverlaps([
        first,
        campaign({
          isActive: false,
          startDate: second.startDate,
          endDate: second.endDate,
        }),
      ]),
    ).toEqual([]);
  });

  it("builds Monday-first calendar weeks and marks campaigns by intersecting day", () => {
    const days = getCalendarDays(2026, 5);
    expect(days[0].toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(days).toHaveLength(35);
    expect(
      campaignIncludesCalendarDay(campaign(), new Date("2026-06-09T00:00:00.000Z")),
    ).toBe(true);
    expect(
      campaignIncludesCalendarDay(campaign(), new Date("2026-06-10T00:00:00.000Z")),
    ).toBe(false);
  });

  it("rejects malformed campaign payloads instead of displaying bad dates", () => {
    expect(() => parseRewardCampaigns({ campaigns: [{ ...campaign(), endDate: "bad" }] }))
      .toThrow("Reward campaign calendar response is invalid.");
    expect(parseRewardCampaigns({ campaigns: [] })).toEqual([]);
  });
});
