/**
 * Route quote assumptions (#route-assumptions)
 *
 * Covers the structured provider/asset/APY-source/fee/freshness assumptions
 * attached to zap quotes:
 *  - complete data: every group populated, nothing reported unavailable;
 *  - partially unavailable data: missing groups become null and are listed in
 *    `unavailableFields` (no invented zeros, no thrown errors);
 *  - no matching protocol: quote still succeeds with all groups unavailable;
 *  - the assumptions flow through getZapQuote and POST /api/zap/quote.
 */

import request from "supertest";
import express from "express";
import {
  buildZapQuoteRouteAssumptions,
  ROUTE_ASSUMPTION_FRESHNESS_WINDOW_SECONDS,
} from "../services/routeAssumptionsService";
import { getZapQuote } from "../services/zapQuote";
import type { NormalizedYield } from "../types/yields";

// Prevent real Stellar network calls during CI.
jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn(),
}));

// Freeze checks are irrelevant here.
jest.mock("../services/freezeService", () => ({
  freezeService: { isFrozen: jest.fn().mockReturnValue(false) },
}));

// Mount the zap router directly on a bare express app so this file does not
// depend on createApp()'s full route graph. vaultPauseStateService is mocked
// so the contract-registry checksum gate never loads.
jest.mock("../services/vaultPauseStateService", () => ({
  getVaultPauseState: jest.fn().mockResolvedValue({
    status: "active",
    checkedAt: "2026-01-01T00:00:00.000Z",
  }),
}));

import { getYieldData } from "../services/yieldService";
import zapRouter from "../routes/zap";

const mockGetYieldData = getYieldData as jest.MockedFunction<typeof getYieldData>;

// Fixed reference time for the pure builder tests (nowMs is injected there).
const NOW = new Date("2026-10-20T12:00:00.000Z").getTime();
const FRESH_AT = new Date(NOW - 60_000).toISOString(); // 60s old relative to NOW
const STALE_AT = new Date(NOW - (ROUTE_ASSUMPTION_FRESHNESS_WINDOW_SECONDS + 60) * 1000).toISOString();

// getZapQuote derives freshness from the real clock, so its fixture must be
// relative to Date.now() rather than the fixed NOW above.
function freshEntry(overrides: Partial<NormalizedYield> = {}): NormalizedYield {
  return makeYieldEntry({
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  });
}

function makeYieldEntry(overrides: Partial<NormalizedYield> = {}): NormalizedYield {
  return {
    protocol: "Blend",
    asset: "USDC",
    risk: "Medium",
    protocolName: "Blend",
    apy: 8.1,
    rewardApy: 1.2,
    totalApy: 9.3,
    netApy: 8.4,
    feeDragApy: 0.9,
    tvl: 12_000_000,
    riskScore: 42,
    source: "api",
    fetchedAt: FRESH_AT,
    liquidityUsd: 3_000_000,
    rebalancingBehavior: "steady",
    managementFeeBps: 0,
    performanceFeeBps: 1000,
    capitalEfficiencyPct: 80,
    netYieldAssumptions: {
      protocolFeeBps: 1000,
      vaultFeeBps: 0,
      rebalanceCostBps: 5,
      slippageBps: 10,
    },
    netYieldSensitivity: [],
    capitalEfficiency: {
      score: 80,
      grade: "B",
      components: {
        utilization: 85,
        feeDrag: 70,
        rotationCost: 80,
        liquidityDepth: 85,
      },
      hasMissingInputs: false,
    },
    attribution: {
      baseYield: 6.5,
      incentives: 1.2,
      compounding: 1.0,
      tacticalRotation: 0.6,
    },
    ...overrides,
  };
}

describe("buildZapQuoteRouteAssumptions — complete assumptions", () => {
  it("populates provider, asset, APY source, fee, and freshness with nothing unavailable", () => {
    const result = buildZapQuoteRouteAssumptions("blend", [makeYieldEntry()], NOW);

    expect(result.protocol).toBe("blend");
    expect(result.provider).toEqual({
      providerId: "blend",
      providerName: "Blend",
    });
    expect(result.asset).toEqual({ symbol: "USDC" });
    expect(result.apySource).toEqual({
      source: "api",
      totalApy: 9.3,
      netApy: 8.4,
    });
    expect(result.fee).toEqual({
      managementFeeBps: 0,
      performanceFeeBps: 1000,
      protocolFeeBps: 1000,
    });
    expect(result.freshness).toEqual({
      fetchedAt: FRESH_AT,
      ageSeconds: 60,
      isStale: false,
    });
    expect(result.unavailableFields).toEqual([]);
    expect(result.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it("matches the protocol case-insensitively", () => {
    const result = buildZapQuoteRouteAssumptions("BLEND", [makeYieldEntry()], NOW);
    expect(result.provider?.providerName).toBe("Blend");
    expect(result.unavailableFields).toEqual([]);
  });

  it("marks freshness stale beyond the freshness window", () => {
    const result = buildZapQuoteRouteAssumptions(
      "blend",
      [makeYieldEntry({ fetchedAt: STALE_AT })],
      NOW,
    );
    expect(result.freshness?.isStale).toBe(true);
    expect(result.freshness?.ageSeconds).toBe(
      ROUTE_ASSUMPTION_FRESHNESS_WINDOW_SECONDS + 60,
    );
    // Stale data is still available — it is not listed as unavailable.
    expect(result.unavailableFields).toEqual([]);
  });
});

describe("buildZapQuoteRouteAssumptions — partially unavailable assumptions", () => {
  it("reports fee unavailable when the entry has no fee schedule, without inventing zeros", () => {
    const entry = makeYieldEntry({
      managementFeeBps: Number.NaN,
      performanceFeeBps: Number.NaN,
    });
    const result = buildZapQuoteRouteAssumptions("blend", [entry], NOW);

    expect(result.fee).toBeNull();
    expect(result.unavailableFields).toContain("fee");
    // Everything else still resolves.
    expect(result.provider).not.toBeNull();
    expect(result.asset).not.toBeNull();
    expect(result.apySource).not.toBeNull();
    expect(result.freshness).not.toBeNull();
  });

  it("keeps a partial fee schedule when only one component is present", () => {
    const entry = makeYieldEntry({
      managementFeeBps: 30,
      performanceFeeBps: Number.NaN,
    });
    const result = buildZapQuoteRouteAssumptions("blend", [entry], NOW);

    expect(result.fee).toEqual({
      managementFeeBps: 30,
      protocolFeeBps: 30,
    });
    expect(result.unavailableFields).not.toContain("fee");
  });

  it("reports freshness unavailable when fetchedAt is missing or unparseable", () => {
    const missing = buildZapQuoteRouteAssumptions(
      "blend",
      [makeYieldEntry({ fetchedAt: "" })],
      NOW,
    );
    expect(missing.freshness).toBeNull();
    expect(missing.unavailableFields).toContain("freshness");

    const unparseable = buildZapQuoteRouteAssumptions(
      "blend",
      [makeYieldEntry({ fetchedAt: "not-a-timestamp" })],
      NOW,
    );
    expect(unparseable.freshness).toBeNull();
    expect(unparseable.unavailableFields).toContain("freshness");
  });

  it("reports APY source unavailable when the source label is empty", () => {
    const result = buildZapQuoteRouteAssumptions(
      "blend",
      [makeYieldEntry({ source: "" })],
      NOW,
    );
    expect(result.apySource).toBeNull();
    expect(result.unavailableFields).toContain("apySource");
  });
});

describe("buildZapQuoteRouteAssumptions — no matching protocol", () => {
  it("marks every group unavailable but still returns a valid snapshot", () => {
    const result = buildZapQuoteRouteAssumptions("unknown-protocol", [makeYieldEntry()], NOW);

    expect(result.protocol).toBe("unknown-protocol");
    expect(result.provider).toBeNull();
    expect(result.asset).toBeNull();
    expect(result.apySource).toBeNull();
    expect(result.fee).toBeNull();
    expect(result.freshness).toBeNull();
    expect(result.unavailableFields).toEqual([
      "provider",
      "asset",
      "apySource",
      "fee",
      "freshness",
    ]);
  });

  it("handles an empty or missing yield feed without throwing", () => {
    expect(() => buildZapQuoteRouteAssumptions("blend", [], NOW)).not.toThrow();
    expect(
      buildZapQuoteRouteAssumptions("blend", undefined, NOW).unavailableFields,
    ).toHaveLength(5);
  });
});

describe("getZapQuote attaches route assumptions", () => {
  const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
  const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

  beforeEach(() => {
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  });

  afterAll(() => {
    if (prevRouter === undefined) delete process.env.DEX_ROUTER_CONTRACT_ID;
    else process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    if (prevSim === undefined) delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    else process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
  });

  it("includes complete route assumptions derived from the yield feed", async () => {
    mockGetYieldData.mockResolvedValueOnce([freshEntry()]);

    const quote = await getZapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
      protocol: "blend",
    });

    expect(quote.routeAssumptions).toBeDefined();
    expect(quote.routeAssumptions?.provider?.providerName).toBe("Blend");
    expect(quote.routeAssumptions?.asset?.symbol).toBe("USDC");
    expect(quote.routeAssumptions?.apySource?.source).toBe("api");
    expect(quote.routeAssumptions?.fee?.protocolFeeBps).toBe(1000);
    expect(quote.routeAssumptions?.freshness?.isStale).toBe(false);
    expect(quote.routeAssumptions?.unavailableFields).toEqual([]);
  });

  it("still quotes when the yield feed has no matching protocol, with all groups unavailable", async () => {
    mockGetYieldData.mockResolvedValueOnce([freshEntry()]);

    const quote = await getZapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
      protocol: "nonexistent",
    });

    expect(quote.expectedAmountOutStroops).toBeDefined();
    expect(quote.routeAssumptions?.provider).toBeNull();
    expect(quote.routeAssumptions?.unavailableFields).toEqual([
      "provider",
      "asset",
      "apySource",
      "fee",
      "freshness",
    ]);
  });
});

describe("POST /api/zap/quote passes routeAssumptions through", () => {
  const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
  const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

  let app: express.Express;

  beforeAll(() => {
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    app = express();
    app.use(express.json());
    app.use("/api/zap", zapRouter);
  });

  afterAll(() => {
    if (prevRouter === undefined) delete process.env.DEX_ROUTER_CONTRACT_ID;
    else process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    if (prevSim === undefined) delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    else process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
  });

  const SAME_TOKEN = "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it("returns routeAssumptions alongside the fingerprint fields", async () => {
    mockGetYieldData.mockResolvedValueOnce([freshEntry({ protocolName: "default", protocol: "default" })]);

    const res = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: SAME_TOKEN,
        vaultTokenContract: SAME_TOKEN,
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

    expect(res.status).toBe(200);
    expect(res.body.routeAssumptions).toBeDefined();
    expect(res.body.routeAssumptions.protocol).toBe("default");
    expect(res.body.routeAssumptions.provider).toEqual({
      providerId: "default",
      providerName: "default",
    });
    expect(res.body.routeAssumptions.asset).toEqual({ symbol: "USDC" });
    expect(res.body.routeAssumptions.unavailableFields).toEqual([]);
    // Existing fingerprint fields remain untouched.
    expect(res.body.assumptionFingerprint).toBeDefined();
    expect(res.body.assumptions).toBeDefined();
  });
});
