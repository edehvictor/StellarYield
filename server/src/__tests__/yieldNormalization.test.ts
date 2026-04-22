import { normalizeYield, normalizeYields } from "../utils/yieldNormalization";
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
};

describe("yield normalization utilities", () => {
  it("normalizes a raw protocol payload into the frontend shape", () => {
    const normalized = normalizeYield(rawYield);

    expect(normalized).toEqual({
      protocolName: "Blend",
      apy: 6.75,
      tvl: 12_500_000.57,
      riskScore: expect.any(Number),
      source: "stellar://blend",
      fetchedAt: "2026-03-25T10:00:00.000Z",
    });
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
