import { evaluateCampaignBudget, RewardCampaignBudget } from "../campaignBudgetService";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("campaignBudgetService.evaluateCampaignBudget (#1160)", () => {
  it("flags a fully depleted campaign", () => {
    const campaign: RewardCampaignBudget = {
      campaignId: "week-24",
      totalBudget: 1000,
      claims: [
        { amount: 700, claimedAt: daysAgo(3) },
        { amount: 300, claimedAt: daysAgo(1) },
      ],
    };

    const result = evaluateCampaignBudget(campaign, NOW);

    expect(result.status).toBe("depleted");
    expect(result.remainingBudget).toBe(0);
  });

  it("flags a low-budget campaign and estimates coverage from recent velocity", () => {
    const campaign: RewardCampaignBudget = {
      campaignId: "week-25",
      totalBudget: 1000,
      claims: [
        { amount: 700, claimedAt: daysAgo(10) },
        // 200 claimed within the trailing 7-day window -> velocity 200/7 per day.
        { amount: 200, claimedAt: daysAgo(2) },
      ],
    };

    const result = evaluateCampaignBudget(campaign, NOW);

    expect(result.status).toBe("low");
    expect(result.remainingBudget).toBe(100);
    expect(result.estimatedDaysRemaining).not.toBeNull();
    expect(result.estimatedDaysRemaining).toBeCloseTo(3.5, 1);
  });

  it("reports a healthy campaign with plenty of remaining budget", () => {
    const campaign: RewardCampaignBudget = {
      campaignId: "week-26",
      totalBudget: 1000,
      claims: [{ amount: 50, claimedAt: daysAgo(1) }],
    };

    const result = evaluateCampaignBudget(campaign, NOW);

    expect(result.status).toBe("healthy");
    expect(result.remainingBudget).toBe(950);
  });

  it("does not produce a misleading estimate for a campaign with no claims", () => {
    const campaign: RewardCampaignBudget = {
      campaignId: "week-27",
      totalBudget: 1000,
      claims: [],
    };

    const result = evaluateCampaignBudget(campaign, NOW);

    expect(result.status).toBe("healthy");
    expect(result.estimatedDaysRemaining).toBeNull();
  });

  it("does not estimate coverage when claim history is stale (outside the velocity window)", () => {
    const campaign: RewardCampaignBudget = {
      campaignId: "week-28",
      totalBudget: 1000,
      claims: [{ amount: 950, claimedAt: daysAgo(30) }],
    };

    const result = evaluateCampaignBudget(campaign, NOW);

    expect(result.status).toBe("low");
    expect(result.estimatedDaysRemaining).toBeNull();
  });
});
