/**
 * Tests for asset identity normalization and duplicate-holdings merging.
 *
 * Covers:
 *  - resolveCanonicalSymbol / resolveCanonicalIssuer (unit)
 *  - resolveAssetIdentity (unit)
 *  - mergeHoldings / normalizeAndMergeHoldings (integration)
 *    • symbol aliases collapse into one holding row
 *    • issuer aliases collapse into one holding row
 *    • merged row preserves all source contribution details
 *    • unknown assets remain visible without merging
 *  - reconcilePortfolio with alias-aware matching (free function)
 *  - detectDuplicatePositions with alias variants (class method)
 */

import {
  resolveCanonicalSymbol,
  resolveCanonicalIssuer,
  resolveAssetIdentity,
  mergeHoldings,
  type RawHolding,
} from "../services/assetIdentityService";

import {
  normalizeAndMergeHoldings,
  reconcilePortfolio,
  PortfolioReconcileService,
  type PortfolioPosition,
} from "../services/portfolioReconcileService";

// ── resolveCanonicalSymbol ────────────────────────────────────────────────

describe("resolveCanonicalSymbol", () => {
  it("resolves 'usdc' → USDC and marks it known", () => {
    const r = resolveCanonicalSymbol("usdc");
    expect(r.canonical).toBe("USDC");
    expect(r.isKnown).toBe(true);
  });

  it("resolves 'USD Coin' → USDC", () => {
    expect(resolveCanonicalSymbol("USD Coin").canonical).toBe("USDC");
  });

  it("resolves 'xlm' → XLM", () => {
    expect(resolveCanonicalSymbol("xlm").canonical).toBe("XLM");
  });

  it("resolves 'Lumens' → XLM", () => {
    expect(resolveCanonicalSymbol("Lumens").canonical).toBe("XLM");
  });

  it("resolves 'XLM-USDC' LP variants", () => {
    expect(resolveCanonicalSymbol("USDC-XLM").canonical).toBe("XLM-USDC");
    expect(resolveCanonicalSymbol("xlmusdc").canonical).toBe("XLM-USDC");
  });

  it("marks unknown symbols as !isKnown but still returns upper-cased symbol", () => {
    const r = resolveCanonicalSymbol("MYSTERYTOKEN");
    expect(r.isKnown).toBe(false);
    expect(r.canonical).toBe("MYSTERYTOKEN");
  });

  it("is case-insensitive for known aliases", () => {
    expect(resolveCanonicalSymbol("USDC").canonical).toBe("USDC");
    expect(resolveCanonicalSymbol("Usdc").canonical).toBe("USDC");
    expect(resolveCanonicalSymbol("uSdC").canonical).toBe("USDC");
  });
});

// ── resolveCanonicalIssuer ────────────────────────────────────────────────

describe("resolveCanonicalIssuer", () => {
  const MAINNET_CIRCLE_ISSUER =
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const TESTNET_CIRCLE_ISSUER =
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("maps testnet Circle issuer to mainnet canonical", () => {
    const r = resolveCanonicalIssuer(TESTNET_CIRCLE_ISSUER);
    expect(r.canonical).toBe(MAINNET_CIRCLE_ISSUER);
    expect(r.isKnown).toBe(true);
  });

  it("returns the original (upper-cased) for unknown issuers", () => {
    const unknown = "GABCDEFUNKNOWNISSUER12345";
    const r = resolveCanonicalIssuer(unknown);
    expect(r.canonical).toBe(unknown);
    expect(r.isKnown).toBe(false);
  });
});

// ── resolveAssetIdentity ──────────────────────────────────────────────────

describe("resolveAssetIdentity", () => {
  it("native XLM has no issuer and identity key 'XLM'", () => {
    const a = resolveAssetIdentity({ symbol: "XLM" });
    expect(a.canonicalSymbol).toBe("XLM");
    expect(a.canonicalIssuer).toBeUndefined();
    expect(a.identityKey).toBe("XLM");
    expect(a.isKnown).toBe(true);
  });

  it("USDC with a known issuer produces <SYMBOL>:<ISSUER> key", () => {
    const issuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const a = resolveAssetIdentity({ symbol: "usdc", issuer });
    expect(a.canonicalSymbol).toBe("USDC");
    expect(a.identityKey).toBe(`USDC:${issuer}`);
  });

  it("alias symbol + alias issuer both collapse to the same identity key", () => {
    const mainnetIssuer =
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const testnetIssuer =
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

    const a = resolveAssetIdentity({ symbol: "usdc", issuer: mainnetIssuer });
    const b = resolveAssetIdentity({
      symbol: "USD Coin",
      issuer: testnetIssuer,
      displayName: "USD Coin (testnet)",
    });

    expect(a.identityKey).toBe(b.identityKey);
  });

  it("unknown asset preserves raw symbol but marks isKnown false", () => {
    const a = resolveAssetIdentity({
      symbol: "WEIRDTOKEN",
      issuer: "GFAKEISSUER",
    });
    expect(a.isKnown).toBe(false);
    expect(a.raw.symbol).toBe("WEIRDTOKEN");
  });
});

// ── mergeHoldings ─────────────────────────────────────────────────────────

describe("mergeHoldings — symbol aliases", () => {
  it("collapses 'usdc' and 'USDC' entries into one holding row", () => {
    const holdings: RawHolding[] = [
      { asset: { symbol: "usdc" }, amount: 100, source: "wallet" },
      { asset: { symbol: "USDC" }, amount: 200, source: "blend" },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(1);
    expect(merged[0].canonicalSymbol).toBe("USDC");
    expect(merged[0].totalAmount).toBe(300);
  });

  it("collapses 'USD Coin' and 'usdc' into one holding row", () => {
    const holdings: RawHolding[] = [
      { asset: { symbol: "USD Coin" }, amount: 50 },
      { asset: { symbol: "usdc" }, amount: 75 },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(1);
    expect(merged[0].totalAmount).toBe(125);
  });

  it("collapses 'xlm' / 'Lumens' / 'XLM' into one holding", () => {
    const holdings: RawHolding[] = [
      { asset: { symbol: "xlm" }, amount: 1000 },
      { asset: { symbol: "Lumens" }, amount: 500 },
      { asset: { symbol: "XLM" }, amount: 250 },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(1);
    expect(merged[0].canonicalSymbol).toBe("XLM");
    expect(merged[0].totalAmount).toBe(1750);
  });

  it("does NOT merge symbols that resolve to different canonical forms", () => {
    const holdings: RawHolding[] = [
      { asset: { symbol: "USDC" }, amount: 100 },
      { asset: { symbol: "XLM" }, amount: 200 },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(2);
  });
});

describe("mergeHoldings — issuer aliases", () => {
  const mainnetIssuer =
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const testnetIssuer =
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("merges USDC from mainnet and testnet issuers into one row", () => {
    const holdings: RawHolding[] = [
      {
        asset: { symbol: "USDC", issuer: mainnetIssuer },
        amount: 300,
        source: "mainnet-wallet",
      },
      {
        asset: { symbol: "usdc", issuer: testnetIssuer },
        amount: 150,
        source: "testnet-wallet",
      },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(1);
    expect(merged[0].totalAmount).toBe(450);
    expect(merged[0].canonicalIssuer).toBe(mainnetIssuer);
  });
});

describe("mergeHoldings — contribution preservation", () => {
  it("preserves each source contribution on the merged row", () => {
    const holdings: RawHolding[] = [
      {
        asset: { symbol: "usdc" },
        amount: 100,
        source: "blend",
        metadata: { protocol: "Blend" },
      },
      {
        asset: { symbol: "USDC" },
        amount: 200,
        source: "soroswap",
        metadata: { protocol: "Soroswap" },
      },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged[0].contributions).toHaveLength(2);
    expect(merged[0].contributions[0].source).toBe("blend");
    expect(merged[0].contributions[0].amount).toBe(100);
    expect(merged[0].contributions[0].metadata).toEqual({ protocol: "Blend" });
    expect(merged[0].contributions[1].source).toBe("soroswap");
    expect(merged[0].contributions[1].amount).toBe(200);
  });

  it("preserves raw symbol and issuer in each contribution", () => {
    // Use a recognised issuer so both entries collapse into a single merged row
    const knownIssuer =
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const holdings: RawHolding[] = [
      {
        asset: { symbol: "usdc", issuer: knownIssuer },
        amount: 50,
        source: "a",
      },
      {
        asset: { symbol: "USD Coin", issuer: knownIssuer },
        amount: 30,
        source: "b",
      },
    ];
    const merged = mergeHoldings(holdings);
    // Both resolve to the same canonical USDC:<issuer> key → merged into one row
    expect(merged).toHaveLength(1);
    const contribs = merged[0].contributions;
    expect(contribs).toHaveLength(2);
    expect(contribs[0].rawSymbol).toBe("usdc");
    expect(contribs[0].rawIssuer).toBe(knownIssuer);
    expect(contribs[1].rawSymbol).toBe("USD Coin");
    expect(contribs[1].rawIssuer).toBe(knownIssuer);
  });
});

describe("mergeHoldings — unknown assets", () => {
  it("keeps unknown assets as separate rows (no unsafe merging)", () => {
    const holdings: RawHolding[] = [
      { asset: { symbol: "TOKENX" }, amount: 10 },
      { asset: { symbol: "TOKENX" }, amount: 20 },
    ];
    // Both are unknown — they must NOT be merged
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(2);
  });

  it("unknown asset row is still returned (remains visible)", () => {
    const holdings: RawHolding[] = [
      { asset: { symbol: "UNKNOWNTOKEN" }, amount: 999 },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(1);
    expect(merged[0].totalAmount).toBe(999);
    expect(merged[0].isKnown).toBe(false);
  });

  it("does not merge known USDC with an unknown token of the same raw symbol", () => {
    // 'usdc' with no issuer is known; 'WEIRDUSDC' is unknown — different symbols
    const holdings: RawHolding[] = [
      { asset: { symbol: "usdc" }, amount: 100 },
      { asset: { symbol: "WEIRDUSDC" }, amount: 50 },
    ];
    const merged = mergeHoldings(holdings);
    expect(merged).toHaveLength(2);
  });
});

// ── normalizeAndMergeHoldings (via portfolioReconcileService re-export) ───

describe("normalizeAndMergeHoldings re-export", () => {
  it("delegates correctly and returns merged rows", () => {
    const holdings: RawHolding[] = [
      { asset: { symbol: "usdc" }, amount: 10 },
      { asset: { symbol: "USDC" }, amount: 20 },
    ];
    const result = normalizeAndMergeHoldings(holdings);
    expect(result).toHaveLength(1);
    expect(result[0].totalAmount).toBe(30);
  });
});

// ── reconcilePortfolio alias-aware matching ───────────────────────────────

describe("reconcilePortfolio — alias-aware position matching", () => {
  it("matches a position 'USDC' against a balance reported as 'usdc'", () => {
    const rows = reconcilePortfolio(
      [{ asset: "USDC", expected: 100 }],
      [{ provider: "blend", asset: "usdc", balance: 100 }],
    );
    expect(rows[0].severity).toBe("matched");
    expect(rows[0].observed).toBe(100);
  });

  it("matches 'xlm' balance against 'XLM' position", () => {
    const rows = reconcilePortfolio(
      [{ asset: "XLM", expected: 500 }],
      [{ provider: "wallet", asset: "xlm", balance: 500 }],
    );
    expect(rows[0].severity).toBe("matched");
  });

  it("sums alias balances from multiple providers for the same position", () => {
    // Both 'USDC' and 'usd coin' from different providers should sum for the 'USDC' position
    const rows = reconcilePortfolio(
      [{ asset: "USDC", expected: 300 }],
      [
        { provider: "blend", asset: "USDC", balance: 100 },
        { provider: "soroswap", asset: "usd coin", balance: 200 },
      ],
    );
    expect(rows[0].observed).toBe(300);
    expect(rows[0].severity).toBe("matched");
  });

  it("reports unavailable when no alias matches any balance", () => {
    const rows = reconcilePortfolio(
      [{ asset: "BTC", expected: 1 }],
      [{ provider: "blend", asset: "USDC", balance: 9999 }],
    );
    expect(rows[0].severity).toBe("unavailable");
    expect(rows[0].observed).toBeNull();
  });
});

// ── detectDuplicatePositions in PortfolioReconcileService ─────────────────

describe("PortfolioReconcileService.detectDuplicatePositions (via reconcilePortfolio integration)", () => {
  const mockPrisma = {
    vaultBalance: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };

  it("detects alias variants of the same asset in the same vault as duplicates", async () => {
    const service = new PortfolioReconcileService(mockPrisma);

    // Expose the private method via prototype cast for unit testing
    const positions: PortfolioPosition[] = [
      { assetId: "USDC", vaultId: "vault-1", amount: 100, protocol: "Blend" },
      { assetId: "usdc", vaultId: "vault-1", amount: 50, protocol: "Soroswap" }, // alias of USDC
    ];

    // Access private method via cast (acceptable in unit tests)
    const detectDuplicates = (
      service as unknown as {
        detectDuplicatePositions: (p: PortfolioPosition[]) => string[];
      }
    ).detectDuplicatePositions.bind(service);

    const duplicates = detectDuplicates(positions);
    expect(duplicates.length).toBeGreaterThan(0);
    // Both map to the USDC canonical key in vault-1
    expect(duplicates[0]).toMatch(/USDC/i);
  });

  it("does NOT flag distinct assets in the same vault as duplicates", async () => {
    const service = new PortfolioReconcileService(mockPrisma);

    const positions: PortfolioPosition[] = [
      { assetId: "USDC", vaultId: "vault-1", amount: 100, protocol: "Blend" },
      { assetId: "XLM", vaultId: "vault-1", amount: 200, protocol: "Blend" },
    ];

    const detectDuplicates = (
      service as unknown as {
        detectDuplicatePositions: (p: PortfolioPosition[]) => string[];
      }
    ).detectDuplicatePositions.bind(service);

    const duplicates = detectDuplicates(positions);
    expect(duplicates).toHaveLength(0);
  });
});
