import request from "supertest";
import { createApp } from "../app";
import {
  normalizeYield,
  normalizeYields,
  APY_ULP,
  YIELD_NORMALIZATION_CONTRACT,
  blendApyPercent,
  bpsToApyPercent,
  checkYieldParity,
  decimalsOf,
  formatParityReport,
  isAtApyPrecision,
  normalizeApyPercent,
  normalizeUsd,
  roundTo,
  type ComparableYield,
} from "../utils/yieldNormalization";
import { calculateNetYield } from "../services/netYieldEngine";
import {
  buildPortfolioYieldSummary,
  getPortfolioYieldSummary,
  getYieldData,
  getYieldParityReport,
} from "../services/yieldService";
import { simulateDeposit } from "../services/simulationService";
import type { RawProtocolYield } from "../types/yields";

const rawYield: RawProtocolYield = {
  protocolName: "Blend",
  protocolType: "blend",
  apyBps: 675,
  tvlUsd: 12_500_000.567,
  volatilityPct: 2.5,
  protocolAgeDays: 400,
  network: "mainnet",
  source: "stellar://blend",
  fetchedAt: "2026-03-25T10:00:00.000Z",
  liquidityUsd: 6_250_000,
  rebalancingBehavior: "automated",
  managementFeeBps: 25,
  performanceFeeBps: 150,
  capitalEfficiencyPct: 92,
};

describe("yield normalization utilities", () => {
  it("normalizes a raw protocol payload into the frontend shape", () => {
    const normalized = normalizeYield(rawYield);

    expect(normalized).toEqual(
      expect.objectContaining({
        protocolName: "Blend",
        protocol: "Blend",
        asset: "USDC",
        risk: "Low",
        apy: 6.75,
        rewardApy: 0,
        totalApy: 6.75,
        netApy: expect.any(Number),
        feeDragApy: expect.any(Number),
        rewards: [],
        tvl: 12_500_000.57,
        riskScore: expect.any(Number),
        source: "stellar://blend",
        fetchedAt: "2026-03-25T10:00:00.000Z",
        netYieldAssumptions: expect.any(Object),
        netYieldSensitivity: expect.any(Array),
        capitalEfficiency: expect.any(Object),
        attribution: {
          baseYield: expect.any(Number),
          incentives: expect.any(Number),
          compounding: expect.any(Number),
          tacticalRotation: expect.any(Number),
        },
      }),
    );
  });

  it("normalizes multiple yield payloads", () => {
    const normalized = normalizeYields([
      rawYield,
      {
        ...rawYield,
        protocolName: "Soroswap",
        protocolType: "soroswap",
        apyBps: 1120,
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[1].protocolName).toBe("Soroswap");
    expect(normalized[1].apy).toBe(11.2);
  });
});

// ── The contract itself ─────────────────────────────────────────────────

describe("yield normalization contract", () => {
  it("publishes APY in percent at two decimals", () => {
    expect(YIELD_NORMALIZATION_CONTRACT.apy.unit).toBe("percent");
    expect(YIELD_NORMALIZATION_CONTRACT.apy.decimals).toBe(2);
    expect(bpsToApyPercent(675)).toBe(6.75);
    expect(bpsToApyPercent(10_000)).toBe(100);
  });

  it("rounds halfway cases away from zero, symmetrically", () => {
    // Math.round breaks ties towards +Infinity, so a bare
    // `Math.round(v * 100) / 100` gives -0.12 here and disagrees with the
    // positive case by a full ulp.
    expect(normalizeApyPercent(0.125)).toBe(0.13);
    expect(normalizeApyPercent(-0.125)).toBe(-0.13);
    expect(normalizeApyPercent(-0.125)).toBe(-normalizeApyPercent(0.125));
  });

  it("is not fooled by binary representation of decimal halves", () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754.
    expect(normalizeApyPercent(1.005)).toBe(1.01);
    expect(normalizeApyPercent(8.675)).toBe(8.68);
    expect(normalizeUsd(2.675)).toBe(2.68);
  });

  it("never returns negative zero", () => {
    expect(Object.is(normalizeApyPercent(-0.001), 0)).toBe(true);
    expect(Object.is(roundTo(-0, 2), 0)).toBe(true);
  });

  it("reports the decimals a value actually carries", () => {
    expect(decimalsOf(6.75)).toBe(2);
    expect(decimalsOf(6.755)).toBe(3);
    expect(decimalsOf(7)).toBe(0);
    expect(isAtApyPrecision(6.75)).toBe(true);
    expect(isAtApyPrecision(6.7512)).toBe(false);
  });

  it("blends weighted APYs at full precision and rounds once", () => {
    const blended = blendApyPercent([
      { apyPercent: 6.75, weight: 7_500 },
      { apyPercent: 11.2, weight: 2_500 },
    ]);
    // (6.75 * 0.75) + (11.2 * 0.25) === 7.8625 -> 7.86
    expect(blended).toBe(7.86);
  });

  it("blends to zero rather than NaN when there is nothing to weight", () => {
    expect(blendApyPercent([])).toBe(0);
    expect(blendApyPercent([{ apyPercent: 6.75, weight: 0 }])).toBe(0);
  });
});

// ── The regression this issue is about ──────────────────────────────────

describe("feed normalization rounds once", () => {
  const withRewards: RawProtocolYield = {
    ...rawYield,
    // 6.754 % base — deliberately lands between two emitted values.
    apyBps: 675.4,
    tvlUsd: 1_000_000,
    rewards: [
      // 10_040 / 1_000_000 * 100 === 1.004 %
      { tokenSymbol: "BLND", emissionPerYear: 10_040, tokenPrice: 1 },
    ],
  };

  it("derives totalApy from the raw components, not from rounded parts", () => {
    const normalized = normalizeYield(withRewards);

    expect(normalized.apy).toBe(6.75); // round(6.754)
    expect(normalized.rewardApy).toBe(1.0); // round(1.004)
    // round(6.754 + 1.004) === round(7.758) === 7.76, NOT 6.75 + 1.00.
    expect(normalized.totalApy).toBe(7.76);
    expect(normalized.totalApy).not.toBe(
      normalizeApyPercent(normalized.apy + normalized.rewardApy),
    );
  });

  it("keeps netApy identical to the value /api/yields re-derives from totalApy", () => {
    // The route recomputes net yield from the emitted `totalApy`. Before the
    // contract landed, the normalizer derived it from `apy + rewardApy`
    // instead, so the same protocol carried two different netApy values
    // depending on which path a consumer read.
    const normalized = normalizeYield(withRewards);
    const routeDerived = calculateNetYield(normalized.totalApy);

    expect(normalized.netApy).toBe(routeDerived.netApy);
    expect(normalized.feeDragApy).toBe(routeDerived.feeDragApy);
  });

  it("splits a multi-stream reward without accumulating rounding error", () => {
    const multi = normalizeYield({
      ...withRewards,
      rewards: [
        { tokenSymbol: "A", emissionPerYear: 1_004, tokenPrice: 1 }, // 0.1004 %
        { tokenSymbol: "B", emissionPerYear: 1_004, tokenPrice: 1 }, // 0.1004 %
        { tokenSymbol: "C", emissionPerYear: 1_004, tokenPrice: 1 }, // 0.1004 %
      ],
    });

    // Each stream emits 0.10; summing the emitted values gives 0.30, while the
    // true total is 0.3012 -> 0.30. Equal here, but rewardApy must come from
    // the raw sum, which the per-stream values are checked against below.
    expect(multi.rewards?.map((r) => r.apy)).toEqual([0.1, 0.1, 0.1]);
    expect(multi.rewardApy).toBe(0.3);
    expect(multi.totalApy).toBe(normalizeApyPercent(6.754 + 0.3012));
  });

  it("emits every APY and USD field at contract precision", () => {
    for (const entry of normalizeYields([rawYield, withRewards])) {
      expect(isAtApyPrecision(entry.apy)).toBe(true);
      expect(isAtApyPrecision(entry.rewardApy)).toBe(true);
      expect(isAtApyPrecision(entry.totalApy)).toBe(true);
      expect(isAtApyPrecision(entry.netApy)).toBe(true);
      expect(decimalsOf(entry.tvl)).toBeLessThanOrEqual(2);
    }
  });
});

// ── Parity checker diagnostics ──────────────────────────────────────────

describe("checkYieldParity", () => {
  const feed: ComparableYield[] = [
    { protocol: "Blend", apy: 6.75, rewardApy: 1.0, totalApy: 7.76, netApy: 6.37, tvl: 1_000_000 },
  ];

  it("reports parity when both sides agree", () => {
    const report = checkYieldParity(feed, feed);

    expect(report.inParity).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.contractVersion).toBe(YIELD_NORMALIZATION_CONTRACT.version);
    expect(report.comparedFields).toContain("totalApy");
  });

  it("flags a summary still carrying basis points as a UNIT_MISMATCH", () => {
    const summary = [{ ...feed[0], totalApy: 776 }];
    const report = checkYieldParity(feed, summary);

    const issue = report.issues.find((i) => i.field === "totalApy");
    expect(report.inParity).toBe(false);
    expect(issue?.code).toBe("UNIT_MISMATCH");
    expect(issue?.message).toContain("basis points");
    expect(issue?.remediation).toContain("bpsToApyPercent()");
  });

  it("flags a summary carrying a fraction as a UNIT_MISMATCH", () => {
    const summary = [{ ...feed[0], totalApy: 0.0776 }];
    const issue = checkYieldParity(feed, summary).issues.find((i) => i.field === "totalApy");

    expect(issue?.code).toBe("UNIT_MISMATCH");
    expect(issue?.message).toContain("fraction");
  });

  it("flags extra decimals even when both sides carry the same value", () => {
    const overPrecise = [{ ...feed[0], netApy: 6.3719 }];
    const issue = checkYieldParity(overPrecise, overPrecise).issues.find(
      (i) => i.field === "netApy",
    );

    expect(issue?.code).toBe("PRECISION_MISMATCH");
    expect(issue?.delta).toBe(0);
  });

  it("flags extra decimals as a PRECISION_MISMATCH naming the offending side", () => {
    const summary = [{ ...feed[0], netApy: 6.3719 }];
    const issue = checkYieldParity(feed, summary).issues.find((i) => i.field === "netApy");

    expect(issue?.code).toBe("PRECISION_MISMATCH");
    expect(issue?.message).toContain("4 decimals on the summary side");
    expect(issue?.remediation).toContain("normalizeApyPercent()");
  });

  it("flags a one-ulp disagreement as a ROUNDING_MISMATCH", () => {
    // Exactly what double rounding produces: 6.75 + 1.00 instead of
    // round(6.754 + 1.004).
    const summary = [{ ...feed[0], totalApy: 7.75 }];
    const issue = checkYieldParity(feed, summary).issues.find((i) => i.field === "totalApy");

    expect(issue?.code).toBe("ROUNDING_MISMATCH");
    expect(issue?.delta).toBeCloseTo(-APY_ULP, 10);
    expect(issue?.remediation).toContain("round once");
  });

  it("flags a genuine divergence as a VALUE_MISMATCH, not a rounding one", () => {
    const summary = [{ ...feed[0], totalApy: 9.5 }];
    const issue = checkYieldParity(feed, summary).issues.find((i) => i.field === "totalApy");

    expect(issue?.code).toBe("VALUE_MISMATCH");
    expect(issue?.message).toContain("beyond one rounding step");
  });

  it("flags a non-finite value rather than silently comparing NaN", () => {
    const summary = [{ ...feed[0], netApy: Number.NaN }];
    const issue = checkYieldParity(feed, summary).issues.find((i) => i.field === "netApy");

    expect(issue?.code).toBe("NON_FINITE");
    expect(issue?.remediation).toContain("zero TVL");
  });

  it("flags protocols present on only one side", () => {
    const summary = [
      feed[0],
      { protocol: "Soroswap", apy: 11.2, rewardApy: 0, totalApy: 11.2, netApy: 9.19 },
    ];
    const report = checkYieldParity(feed, summary);

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      code: "MISSING_IN_FEED",
      protocol: "Soroswap",
      field: "*",
    });
  });

  it("renders actionable diagnostics for a failing report", () => {
    const report = checkYieldParity(feed, [{ ...feed[0], totalApy: 776 }]);
    const text = formatParityReport(report);

    expect(text).toContain("parity FAILED");
    expect(text).toContain("[UNIT_MISMATCH]");
    expect(text).toContain("fix:");
    expect(text).toContain("server/docs/yield-normalization-contract.md");
  });

  it("renders a one-line summary when everything agrees", () => {
    expect(formatParityReport(checkYieldParity(feed, feed))).toContain("Yield parity OK");
  });
});

// ── Feed vs. summary, on the real path ──────────────────────────────────

describe("market feed and portfolio summary parity", () => {
  it("agrees field-by-field for the live feed", async () => {
    const report = await getYieldParityReport();

    // The assertion message is the diagnostic, so a regression names the
    // protocol, the field, both values and the fix.
    expect(formatParityReport(report)).toContain("Yield parity OK");
    expect(report.inParity).toBe(true);
    expect(report.comparedProtocols.length).toBeGreaterThan(0);
  });

  it("agrees for an unevenly weighted portfolio", async () => {
    const feed = await getYieldData();
    const report = await getYieldParityReport([
      { protocol: feed[0].protocolName, valueUsd: 9_000 },
      { protocol: feed[1].protocolName, valueUsd: 1_000 },
    ]);

    expect(formatParityReport(report)).toContain("Yield parity OK");
    expect(report.summary.positions[0].weightPct).toBe(90);
    expect(report.summary.positions[1].weightPct).toBe(10);
  });

  it("blends weighted APY at contract precision", async () => {
    const feed = await getYieldData();
    const summary = buildPortfolioYieldSummary(
      [
        { protocol: feed[0].protocolName, valueUsd: 7_500 },
        { protocol: feed[1].protocolName, valueUsd: 2_500 },
      ],
      feed,
    );

    expect(summary.blendedTotalApy).toBe(
      blendApyPercent([
        { apyPercent: feed[0].totalApy, weight: 7_500 },
        { apyPercent: feed[1].totalApy, weight: 2_500 },
      ]),
    );
    expect(isAtApyPrecision(summary.blendedTotalApy)).toBe(true);
    expect(summary.totalValueUsd).toBe(10_000);
  });

  it("names positions the feed cannot price instead of dropping them silently", async () => {
    const summary = await getPortfolioYieldSummary([
      { protocol: "GhostProtocol", valueUsd: 1_000 },
    ]);

    expect(summary.unpricedProtocols).toEqual(["GhostProtocol"]);
    expect(summary.positions).toEqual([]);
    expect(summary.blendedTotalApy).toBe(0);
  });

  it("keeps the deposit simulator on the same units and precision as the feed", async () => {
    const feed = await getYieldData();
    const preview = simulateDeposit({ amount: 10_000, strategyId: "blend-stable" });
    const { expectedApy } = preview.postDepositExposure;

    expect(isAtApyPrecision(expectedApy)).toBe(true);

    // A blend-only deposit is spread across the same protocols the feed
    // publishes, so its blended APY must sit inside their published range
    // rather than in bps or as a fraction.
    const blendApys = feed
      .filter((entry) => preview.routing.path.includes(entry.protocolName))
      .map((entry) => entry.apy);

    expect(blendApys.length).toBeGreaterThan(0);
    expect(expectedApy).toBeGreaterThanOrEqual(Math.min(...blendApys) - 0.5);
    expect(expectedApy).toBeLessThanOrEqual(Math.max(...blendApys) + 0.5);
  });
});

// ── The endpoint ────────────────────────────────────────────────────────

describe("GET /api/yields/parity", () => {
  it("returns 200 with an in-parity report", async () => {
    const response = await request(createApp()).get("/api/yields/parity");

    expect(response.status).toBe(200);
    expect(response.body.inParity).toBe(true);
    expect(response.body.issueCount).toBe(0);
    expect(response.body.contractVersion).toBe(YIELD_NORMALIZATION_CONTRACT.version);
    expect(response.body.comparedFields).toEqual(
      expect.arrayContaining(["apy", "rewardApy", "totalApy", "netApy", "tvl"]),
    );
    expect(response.body.diagnostics).toContain("Yield parity OK");
  });

  it("weights the summary by a supplied portfolio", async () => {
    const feed = await getYieldData();
    const response = await request(createApp()).get(
      `/api/yields/parity?positions=${feed[0].protocolName}:8000,${feed[1].protocolName}:2000`,
    );

    expect(response.status).toBe(200);
    expect(response.body.inParity).toBe(true);
    expect(response.body.summary.totalValueUsd).toBe(10_000);
    expect(response.body.summary.positions).toHaveLength(2);
    expect(response.body.summary.positions[0].weightPct).toBe(80);
  });

  it("falls back to equal weights for a malformed positions query", async () => {
    const response = await request(createApp()).get("/api/yields/parity?positions=not-a-portfolio");

    expect(response.status).toBe(200);
    expect(response.body.inParity).toBe(true);
    expect(response.body.summaryCount).toBe(response.body.feedCount);
  });

  it("serves the same netApy that GET /api/yields does", async () => {
    const app = createApp();
    const [yields, parity] = await Promise.all([
      request(app).get("/api/yields"),
      request(app).get("/api/yields/parity"),
    ]);

    expect(yields.status).toBe(200);
    expect(parity.status).toBe(200);

    for (const entry of yields.body) {
      const position = parity.body.summary.positions.find(
        (p: { protocol: string }) => p.protocol === entry.protocolName,
      );
      expect(position).toBeDefined();
      expect(position.netApy).toBe(entry.netApy);
      expect(position.totalApy).toBe(entry.totalApy);
    }
  });
});
