import request from "supertest";
import { createApp } from "../app";
import {
  PortfolioReconcileService,
  canonicalAssetKey,
  classifyReconciliation,
  detectSymbolDrift,
  getReconciliationStore,
  resetReconciliationStore,
  staticPositionSource,
  STALE_PROJECTION_MS,
  type PortfolioPosition,
} from "../services/portfolioReconcileService";
import {
  RECONCILE_CAUSES,
  RECONCILE_CAUSE_ORDER,
  isMissingDataCause,
  isSymbolDriftCause,
  worstSeverity,
} from "../../../shared/types/reconcileCause";

const position = (
  assetId: string,
  amount: number,
  vaultId = "vault-1",
  protocol = "Blend",
): PortfolioPosition => ({ assetId, amount, vaultId, protocol });

/** Prisma double: the reconciler only ever reads and upserts a vault balance. */
const mockPrisma = () => ({
  vaultBalance: {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
  },
});

const FRESH_LEDGER = { ledger: 42, processedAt: new Date() };
const STALE_LEDGER = {
  ledger: 41,
  processedAt: new Date(Date.now() - STALE_PROJECTION_MS - 60_000),
};

// ── The taxonomy ────────────────────────────────────────────────────────

describe("reconcile cause taxonomy", () => {
  it("describes every code with a title, a summary and a remediation", () => {
    for (const code of RECONCILE_CAUSE_ORDER) {
      const descriptor = RECONCILE_CAUSES[code];
      expect(descriptor.title).toBeTruthy();
      expect(descriptor.summary.length).toBeGreaterThan(20);
      expect(descriptor.remediation.length).toBeGreaterThan(20);
    }
  });

  it("covers every declared cause in the triage order", () => {
    expect([...RECONCILE_CAUSE_ORDER].sort()).toEqual(Object.keys(RECONCILE_CAUSES).sort());
  });

  it("separates missing data from symbol drift", () => {
    expect(isMissingDataCause("MISSING_HOLDING")).toBe(true);
    expect(isSymbolDriftCause("MISSING_HOLDING")).toBe(false);
    expect(isSymbolDriftCause("SYMBOL_DRIFT")).toBe(true);
    expect(isMissingDataCause("SYMBOL_DRIFT")).toBe(false);
  });

  it("reports the worst severity across a set of causes", () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity(["STALE_SOURCE"])).toBe("warning");
    expect(worstSeverity(["STALE_SOURCE", "MISSING_HOLDING"])).toBe("critical");
  });
});

// ── Symbol canonicalisation ─────────────────────────────────────────────

describe("canonicalAssetKey", () => {
  it("strips the Stellar issuer qualifier, because an issuer migration is drift", () => {
    expect(canonicalAssetKey("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(
      "USDC",
    );
    expect(canonicalAssetKey("USDC")).toBe("USDC");
  });

  it("resolves multi-word aliases from the shared assetIdentityService table", () => {
    // Keys there contain spaces and hyphens ("usd coin", "xlm-usdc"), so the
    // lookup must run on the raw code, not on a separator-stripped form.
    expect(canonicalAssetKey("USD Coin")).toBe("USDC");
    expect(canonicalAssetKey("usd-coin")).toBe("USDC");
    expect(canonicalAssetKey("native xlm")).toBe("XLM");
    expect(canonicalAssetKey("XLM-USDC")).toBe(canonicalAssetKey("usdc-xlm"));
  });

  it("pairs a holding renamed to a shared-table alias", () => {
    const { drifts } = detectSymbolDrift(
      [position("USD Coin", 1_000)],
      [position("USDC", 1_000)],
    );

    expect(drifts).toHaveLength(1);
    expect(drifts[0].canonicalAsset).toBe("USDC");
  });

  it("folds bridged and wrapped aliases onto the canonical code", () => {
    expect(canonicalAssetKey("USDC.e")).toBe("USDC");
    expect(canonicalAssetKey("usdcet")).toBe("USDC");
    expect(canonicalAssetKey("native")).toBe("XLM");
    expect(canonicalAssetKey("wXLM")).toBe("XLM");
  });

  it("keeps genuinely different assets apart", () => {
    expect(canonicalAssetKey("USDC")).not.toBe(canonicalAssetKey("EURC"));
    expect(canonicalAssetKey("BTC")).not.toBe(canonicalAssetKey("ETH"));
  });
});

describe("detectSymbolDrift", () => {
  it("pairs a renamed holding instead of reporting it twice", () => {
    const { drifts, unmatchedChain, unmatchedCached } = detectSymbolDrift(
      [position("USDC.e", 1_000)],
      [position("USDC", 1_000)],
    );

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      canonicalAsset: "USDC",
      chainAssetId: "USDC.e",
      cachedAssetId: "USDC",
      amountsAgree: true,
    });
    expect(unmatchedChain).toEqual([]);
    expect(unmatchedCached).toEqual([]);
  });

  it("does not pair across vaults", () => {
    const { drifts, unmatchedChain, unmatchedCached } = detectSymbolDrift(
      [position("USDC.e", 1_000, "vault-1")],
      [position("USDC", 1_000, "vault-2")],
    );

    expect(drifts).toEqual([]);
    expect(unmatchedChain).toHaveLength(1);
    expect(unmatchedCached).toHaveLength(1);
  });

  it("consumes each cached candidate once", () => {
    const { drifts, unmatchedChain } = detectSymbolDrift(
      [position("USDC.e", 1_000), position("USDCet", 500)],
      [position("USDC", 1_000)],
    );

    expect(drifts).toHaveLength(1);
    expect(unmatchedChain).toHaveLength(1);
  });

  it("still reports drift when the amounts also disagree", () => {
    const { drifts } = detectSymbolDrift(
      [position("USDC.e", 900)],
      [position("USDC", 1_000)],
    );

    expect(drifts[0].amountsAgree).toBe(false);
  });
});

// ── Classification ──────────────────────────────────────────────────────

describe("classifyReconciliation", () => {
  it("returns no causes for a clean reconciliation", () => {
    const result = classifyReconciliation({
      chainPositions: [position("USDC", 1_000)],
      cachedPositions: [position("USDC", 1_000)],
    });

    expect(result.causes).toEqual([]);
    expect(result.primaryCause).toBeNull();
    expect(result.causeCounts).toEqual({});
  });

  it("names a missing holding, with the amount and the vault", () => {
    const result = classifyReconciliation({
      chainPositions: [position("USDC", 1_000, "vault-7")],
      cachedPositions: [],
    });

    expect(result.primaryCause).toBe("MISSING_HOLDING");
    expect(result.causes[0]).toMatchObject({
      code: "MISSING_HOLDING",
      category: "missing-data",
      severity: "critical",
      assetId: "USDC",
      vaultId: "vault-7",
    });
    expect(result.causes[0].detail).toContain("1000 USDC");
    expect(result.causes[0].remediation).toContain("Replay the indexer");
  });

  it("names symbol drift instead of a missing plus an orphaned holding", () => {
    const result = classifyReconciliation({
      chainPositions: [position("USDC.e", 1_000)],
      cachedPositions: [position("USDC", 1_000)],
    });

    expect(result.causeCounts).toEqual({ SYMBOL_DRIFT: 1 });
    expect(result.causeCounts.MISSING_HOLDING).toBeUndefined();
    expect(result.causeCounts.ORPHANED_HOLDING).toBeUndefined();
    expect(result.causes[0].detail).toContain("only the asset code changed");
    expect(result.causes[0].remediation).toContain("alias map");
    expect(result.symbolDrifts[0].canonicalAsset).toBe("USDC");
  });

  it("names a stale source and triages it ahead of the differences it explains", () => {
    const result = classifyReconciliation({
      chainPositions: [position("USDC", 1_000)],
      cachedPositions: [],
      projectionAgeMs: STALE_PROJECTION_MS + 60_000,
      projectionVersion: 3,
      lastLedger: 41,
    });

    expect(result.primaryCause).toBe("STALE_SOURCE");
    expect(result.causeCounts).toEqual({ STALE_SOURCE: 1, MISSING_HOLDING: 1 });

    const stale = result.causes.find((c) => c.code === "STALE_SOURCE");
    expect(stale?.evidence).toMatchObject({ projectionVersion: 3, lastLedger: 41 });
    expect(stale?.detail).toContain("freshness budget");
  });

  it("does not report a source within the freshness budget as stale", () => {
    const result = classifyReconciliation({
      chainPositions: [position("USDC", 1_000)],
      cachedPositions: [position("USDC", 1_000)],
      projectionAgeMs: STALE_PROJECTION_MS - 1_000,
    });

    expect(result.causes).toEqual([]);
  });

  it("names an orphaned holding when the chain drops a position", () => {
    const result = classifyReconciliation({
      chainPositions: [],
      cachedPositions: [position("USDC", 1_000)],
    });

    expect(result.primaryCause).toBe("ORPHANED_HOLDING");
    expect(result.causes[0].category).toBe("missing-data");
  });

  it("names amount drift separately from a missing holding", () => {
    const result = classifyReconciliation({
      chainPositions: [position("USDC", 1_000)],
      cachedPositions: [position("USDC", 900)],
    });

    expect(result.primaryCause).toBe("AMOUNT_DRIFT");
    expect(result.causes[0].detail).toContain("chain 1000 vs cached 900");
  });

  it("names duplicates and orphaned transactions", () => {
    const result = classifyReconciliation({
      chainPositions: [],
      cachedPositions: [],
      duplicatePositions: ["USDC:vault-1"],
      orphanedTransactions: ["abc123"],
    });

    expect(result.causeCounts).toEqual({ DUPLICATE_POSITION: 1, ORPHANED_TRANSACTION: 1 });
    expect(result.primaryCause).toBe("DUPLICATE_POSITION");
  });

  it("reports a thrown source as a cause rather than as a clean run", () => {
    const result = classifyReconciliation({
      chainPositions: [],
      cachedPositions: [],
      sourceError: new Error("horizon timeout"),
    });

    expect(result.primaryCause).toBe("SOURCE_UNAVAILABLE");
    expect(result.causes[0].detail).toContain("horizon timeout");
    expect(result.causes[0].remediation).toContain("not evidence that the portfolio is clean");
  });

  it("reports every distinct cause in one run", () => {
    const result = classifyReconciliation({
      chainPositions: [position("USDC.e", 1_000), position("XLM", 50), position("EURC", 10)],
      cachedPositions: [position("USDC", 1_000), position("XLM", 40), position("BTC", 1)],
      projectionAgeMs: STALE_PROJECTION_MS + 1,
    });

    expect(result.causeCounts).toMatchObject({
      STALE_SOURCE: 1,
      SYMBOL_DRIFT: 1,
      MISSING_HOLDING: 1,
      ORPHANED_HOLDING: 1,
      AMOUNT_DRIFT: 1,
    });
  });
});

// ── The service ─────────────────────────────────────────────────────────

describe("PortfolioReconcileService cause reporting", () => {
  beforeEach(() => resetReconciliationStore());

  const serviceWith = (
    chainPositions: PortfolioPosition[],
    cachedPositions: PortfolioPosition[],
    lastLedger = FRESH_LEDGER,
  ) =>
    new PortfolioReconcileService(
      mockPrisma(),
      undefined,
      staticPositionSource({ chainPositions, cachedPositions, projectionVersion: 2, lastLedger }),
    );

  it("returns success with no causes when the two sides agree", async () => {
    const result = await serviceWith([position("USDC", 1_000)], [position("USDC", 1_000)])
      .reconcilePortfolio("GWALLET", true);

    expect(result.status).toBe("success");
    expect(result.causes).toEqual([]);
    expect(result.primaryCause).toBeNull();
  });

  it("reports a missing holding as a partial run with a cause", async () => {
    const result = await serviceWith([position("USDC", 1_000)], [])
      .reconcilePortfolio("GWALLET", true);

    expect(result.status).toBe("partial");
    expect(result.primaryCause).toBe("MISSING_HOLDING");
    expect(result.causes[0].title).toBe("Missing holding");
  });

  it("reports symbol drift on the real reconcile path", async () => {
    const result = await serviceWith([position("USDC.e", 1_000)], [position("USDC", 1_000)])
      .reconcilePortfolio("GWALLET", true);

    expect(result.primaryCause).toBe("SYMBOL_DRIFT");
    expect(result.symbolDrifts).toHaveLength(1);
    expect(result.causeCounts.MISSING_HOLDING).toBeUndefined();
  });

  it("reports a stale source from the projection checkpoint", async () => {
    const result = await serviceWith([], [], STALE_LEDGER).reconcilePortfolio("GWALLET", true);

    expect(result.isStale).toBe(true);
    expect(result.primaryCause).toBe("STALE_SOURCE");
    expect(result.staleDurationMs).toBeGreaterThan(STALE_PROJECTION_MS);
  });

  it("reports a thrown source as SOURCE_UNAVAILABLE rather than a clean failure", async () => {
    const service = new PortfolioReconcileService(mockPrisma(), undefined, {
      async fetchChainPositions() {
        throw new Error("horizon unreachable");
      },
    });

    const result = await service.reconcilePortfolio("GWALLET", true);

    expect(result.status).toBe("failed");
    expect(result.primaryCause).toBe("SOURCE_UNAVAILABLE");
    expect(result.causes[0].detail).toContain("horizon unreachable");
  });

  it("records the cause summary in the durable reconciliation history", async () => {
    await serviceWith([position("USDC.e", 1_000)], [position("USDC", 1_000)])
      .reconcilePortfolio("GWALLET", true);

    const [entry] = getReconciliationStore();
    expect(entry.metadata?.primaryCause).toBe("SYMBOL_DRIFT");
    expect(entry.metadata?.causeCounts).toEqual({ SYMBOL_DRIFT: 1 });
  });

  it("falls back to the prisma-backed cache when no position source is supplied", async () => {
    const prisma = mockPrisma();
    prisma.vaultBalance.findUnique.mockResolvedValue({ walletAddress: "GWALLET", tvl: 250 });

    const result = await new PortfolioReconcileService(prisma).reconcilePortfolio("GWALLET", true);

    expect(prisma.vaultBalance.findUnique).toHaveBeenCalled();
    // Chain side is empty without a source, so the cached USDC row is orphaned.
    expect(result.primaryCause).toBe("ORPHANED_HOLDING");
  });
});

// ── The API ─────────────────────────────────────────────────────────────

describe("POST /api/portfolio/reconcile", () => {
  const app = () => createApp();

  it("returns 200 and names symbol drift, distinct from missing data", async () => {
    const response = await request(app())
      .post("/api/portfolio/reconcile")
      .send({
        walletAddress: "GWALLET",
        chainPositions: [{ assetId: "USDC.e", amount: 1000, vaultId: "v1", protocol: "Blend" }],
        cachedPositions: [{ assetId: "USDC", amount: 1000, vaultId: "v1", protocol: "Blend" }],
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("partial");
    expect(response.body.primaryCause).toBe("SYMBOL_DRIFT");
    expect(response.body.causeCounts).toEqual({ SYMBOL_DRIFT: 1 });
    expect(response.body.causes[0]).toMatchObject({
      code: "SYMBOL_DRIFT",
      category: "symbol-drift",
      title: "Symbol drift",
    });
    expect(response.body.symbolDrifts[0].canonicalAsset).toBe("USDC");
  });

  it("returns 200 and names a missing holding", async () => {
    const response = await request(app())
      .post("/api/portfolio/reconcile")
      .send({
        walletAddress: "GWALLET",
        chainPositions: [{ assetId: "USDC", amount: 1000, vaultId: "v1", protocol: "Blend" }],
        cachedPositions: [],
      });

    expect(response.status).toBe(200);
    expect(response.body.primaryCause).toBe("MISSING_HOLDING");
    expect(response.body.causes[0].category).toBe("missing-data");
    expect(response.body.causes[0].remediation).toBeTruthy();
  });

  it("returns 200 and names a stale source from lastLedger", async () => {
    const response = await request(app())
      .post("/api/portfolio/reconcile")
      .send({
        walletAddress: "GWALLET",
        chainPositions: [],
        cachedPositions: [],
        projectionVersion: 9,
        lastLedger: {
          ledger: 41,
          processedAt: new Date(Date.now() - STALE_PROJECTION_MS - 60_000).toISOString(),
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.primaryCause).toBe("STALE_SOURCE");
    expect(response.body.isStale).toBe(true);
    expect(response.body.causes[0].evidence).toMatchObject({ projectionVersion: 9, lastLedger: 41 });
  });

  it("returns 200 with no causes for a clean reconciliation", async () => {
    const response = await request(app())
      .post("/api/portfolio/reconcile")
      .send({
        walletAddress: "GWALLET",
        chainPositions: [{ assetId: "USDC", amount: 1000, vaultId: "v1", protocol: "Blend" }],
        cachedPositions: [{ assetId: "USDC", amount: 1000, vaultId: "v1", protocol: "Blend" }],
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("success");
    expect(response.body.causes).toEqual([]);
    expect(response.body.primaryCause).toBeNull();
  });

  it("rejects a request without a wallet address", async () => {
    const response = await request(app()).post("/api/portfolio/reconcile").send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_REQUEST");
  });

  it("rejects malformed positions rather than silently dropping them", async () => {
    const response = await request(app())
      .post("/api/portfolio/reconcile")
      .send({
        walletAddress: "GWALLET",
        chainPositions: [{ assetId: "USDC" }],
        cachedPositions: [],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_POSITION");
    expect(response.body.message).toContain("finite numeric `amount`");
  });

  it("rejects an unparseable ledger timestamp", async () => {
    const response = await request(app())
      .post("/api/portfolio/reconcile")
      .send({
        walletAddress: "GWALLET",
        chainPositions: [],
        cachedPositions: [],
        lastLedger: { ledger: 1, processedAt: "not-a-date" },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_LEDGER");
  });
});

describe("GET /api/portfolio/reconcile/causes", () => {
  it("returns the taxonomy in triage order", async () => {
    const response = await request(createApp()).get("/api/portfolio/reconcile/causes");

    expect(response.status).toBe(200);
    expect(response.body.order).toEqual(RECONCILE_CAUSE_ORDER);
    expect(response.body.causes).toHaveLength(RECONCILE_CAUSE_ORDER.length);
    expect(response.body.causes[0]).toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      remediation: expect.any(String),
    });
  });
});
