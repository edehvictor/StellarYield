import {
  PortfolioService,
  type VaultPosition,
} from "../services/portfolioService";

const NOW = new Date("2026-06-30T12:00:00.000Z");

describe("PortfolioService.attachFreshness", () => {
  it("marks a recently-fetched holding as fresh", () => {
    const positions: VaultPosition[] = [
      {
        protocol: "Blend",
        asset: "USDC",
        depositedUsd: 5000,
        currentValueUsd: 5162.5,
        fetchedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    ];

    const [holding] = PortfolioService.attachFreshness(positions, NOW);
    expect(holding.freshness.status).toBe("fresh");
  });

  it("marks an old holding as stale", () => {
    const positions: VaultPosition[] = [
      {
        protocol: "Soroswap",
        asset: "XLM-USDC",
        depositedUsd: 2000,
        currentValueUsd: 2122,
        fetchedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      },
    ];

    const [holding] = PortfolioService.attachFreshness(positions, NOW);
    expect(holding.freshness.status).toBe("stale");
  });

  it("marks a holding with no fetchedAt as unknown", () => {
    const positions: VaultPosition[] = [
      {
        protocol: "DeFindex",
        asset: "Yield Index",
        depositedUsd: 3000,
        currentValueUsd: 3133.5,
      },
    ];

    const [holding] = PortfolioService.attachFreshness(positions, NOW);
    expect(holding.freshness.status).toBe("unknown");
  });

  it("preserves every original field on the holding", () => {
    const positions: VaultPosition[] = [
      {
        protocol: "Blend",
        asset: "USDC",
        depositedUsd: 5000,
        currentValueUsd: 5162.5,
        fetchedAt: NOW.toISOString(),
      },
    ];

    const [holding] = PortfolioService.attachFreshness(positions, NOW);
    expect(holding.protocol).toBe("Blend");
    expect(holding.asset).toBe("USDC");
    expect(holding.depositedUsd).toBe(5000);
    expect(holding.currentValueUsd).toBe(5162.5);
  });

  it("handles a mix of fresh, stale, and unknown holdings in one call", () => {
    const positions: VaultPosition[] = [
      { protocol: "A", asset: "USDC", depositedUsd: 100, currentValueUsd: 100, fetchedAt: new Date(NOW.getTime() - 10_000).toISOString() },
      { protocol: "B", asset: "USDC", depositedUsd: 100, currentValueUsd: 100, fetchedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() },
      { protocol: "C", asset: "USDC", depositedUsd: 100, currentValueUsd: 100 },
    ];

    const holdings = PortfolioService.attachFreshness(positions, NOW);
    expect(holdings.map((h) => h.freshness.status)).toEqual(["fresh", "stale", "unknown"]);
  });

  it("returns an empty array for empty input", () => {
    expect(PortfolioService.attachFreshness([], NOW)).toEqual([]);
  });
});

describe("PortfolioService.holdingsToCsv", () => {
  it("includes a header row with a Source Freshness column", () => {
    const csv = PortfolioService.holdingsToCsv([]);
    expect(csv).toContain("Source Freshness");
    expect(csv).toContain("Last Updated");
  });

  it("preserves the fresh state in an exported row", () => {
    const positions: VaultPosition[] = [
      {
        protocol: "Blend",
        asset: "USDC",
        depositedUsd: 5000,
        currentValueUsd: 5162.5,
        fetchedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    ];
    const holdings = PortfolioService.attachFreshness(positions, NOW);
    const csv = PortfolioService.holdingsToCsv(holdings);

    const dataRow = csv.split("\n")[1];
    expect(dataRow).toContain("fresh");
  });

  it("preserves the stale state in an exported row", () => {
    const positions: VaultPosition[] = [
      {
        protocol: "Soroswap",
        asset: "XLM-USDC",
        depositedUsd: 2000,
        currentValueUsd: 2122,
        fetchedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      },
    ];
    const holdings = PortfolioService.attachFreshness(positions, NOW);
    const csv = PortfolioService.holdingsToCsv(holdings);

    const dataRow = csv.split("\n")[1];
    expect(dataRow).toContain("stale");
  });

  it("preserves the unknown state (and does not crash on a missing timestamp) in an exported row", () => {
    const positions: VaultPosition[] = [
      {
        protocol: "DeFindex",
        asset: "Yield Index",
        depositedUsd: 3000,
        currentValueUsd: 3133.5,
      },
    ];
    const holdings = PortfolioService.attachFreshness(positions, NOW);
    const csv = PortfolioService.holdingsToCsv(holdings);

    const dataRow = csv.split("\n")[1];
    expect(dataRow).toContain("unknown");
  });

  it("produces one data row per holding, in order, with no dropped rows", () => {
    const positions: VaultPosition[] = [
      { protocol: "A", asset: "USDC", depositedUsd: 100, currentValueUsd: 110, fetchedAt: NOW.toISOString() },
      { protocol: "B", asset: "USDC", depositedUsd: 200, currentValueUsd: 210 },
      { protocol: "C", asset: "USDC", depositedUsd: 300, currentValueUsd: 310, fetchedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() },
    ];
    const holdings = PortfolioService.attachFreshness(positions, NOW);
    const csv = PortfolioService.holdingsToCsv(holdings);

    const lines = csv.split("\n");
    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[1].startsWith("A,")).toBe(true);
    expect(lines[2].startsWith("B,")).toBe(true);
    expect(lines[3].startsWith("C,")).toBe(true);
  });

  it("quotes a field containing a comma instead of corrupting the row", () => {
    const positions: VaultPosition[] = [
      { protocol: "Blend, Inc", asset: "USDC", depositedUsd: 100, currentValueUsd: 100, fetchedAt: NOW.toISOString() },
    ];
    const holdings = PortfolioService.attachFreshness(positions, NOW);
    const csv = PortfolioService.holdingsToCsv(holdings);

    expect(csv).toContain('"Blend, Inc"');
  });
});