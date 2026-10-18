import { calculateTreasuryRunway, RunwayCashflowEntry } from "../treasuryRunwayService";

const ASOF = new Date("2026-06-15T00:00:00.000Z");

describe("treasuryRunwayService.calculateTreasuryRunway (#1161)", () => {
  it("reports healthy with no breach projected for net-positive inflow", () => {
    const cashflows: RunwayCashflowEntry[] = [
      { date: "2026-06-13", amount: 500 },
      { date: "2026-06-14", amount: 700 },
    ];

    const result = calculateTreasuryRunway(10_000, cashflows, 2_000, ASOF);

    expect(result.status).toBe("healthy");
    expect(result.daysToBreach).toBeNull();
    expect(result.breachDate).toBeNull();
    expect(result.netDailyFlow).toBe(600);
  });

  it("projects a breach date for sustained net outflow", () => {
    const cashflows: RunwayCashflowEntry[] = [
      { date: "2026-06-13", amount: -100 },
      { date: "2026-06-14", amount: -100 },
    ];
    // reserve 1000, threshold 500 -> 500 to burn at 100/day -> 5 days.

    const result = calculateTreasuryRunway(1_000, cashflows, 500, ASOF);

    expect(result.status).toBe("warning");
    expect(result.daysToBreach).toBe(5);
    expect(result.breachDate).toBe("2026-06-20");
  });

  it("treats flat cashflow (net zero) as healthy with no breach", () => {
    const cashflows: RunwayCashflowEntry[] = [
      { date: "2026-06-13", amount: 200 },
      { date: "2026-06-14", amount: -200 },
    ];

    const result = calculateTreasuryRunway(5_000, cashflows, 1_000, ASOF);

    expect(result.netDailyFlow).toBe(0);
    expect(result.status).toBe("healthy");
    expect(result.daysToBreach).toBeNull();
  });

  it("reports an immediate breach when the reserve is already at or below threshold", () => {
    const cashflows: RunwayCashflowEntry[] = [{ date: "2026-06-14", amount: 100 }];

    const result = calculateTreasuryRunway(400, cashflows, 500, ASOF);

    expect(result.status).toBe("breach");
    expect(result.daysToBreach).toBe(0);
    expect(result.breachDate).toBe("2026-06-15");
  });

  it("rounds net daily flow to two decimal places", () => {
    const cashflows: RunwayCashflowEntry[] = [
      { date: "2026-06-13", amount: 10 },
      { date: "2026-06-14", amount: 10 },
      { date: "2026-06-15", amount: 10.5 },
    ];
    // (10 + 10 + 10.5) / 3 = 10.1666... -> rounds to 10.17

    const result = calculateTreasuryRunway(5_000, cashflows, 1_000, ASOF);

    expect(result.netDailyFlow).toBe(10.17);
  });

  it("handles a reserve threshold breach driven by negative-only cashflow with no rows", () => {
    const result = calculateTreasuryRunway(0, [], 100, ASOF);

    expect(result.netDailyFlow).toBe(0);
    expect(result.status).toBe("breach");
    expect(result.daysToBreach).toBe(0);
  });
});
