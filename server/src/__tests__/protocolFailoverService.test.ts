import {
  applyFailover,
  DEFAULT_FAILOVER_THRESHOLDS,
  evaluateProtocolHealth,
  FailoverRegistry,
  type ProtocolHealthInput,
} from "../services/protocolFailoverService";

const FIXED_NOW = Date.parse("2026-04-28T12:00:00Z");

const makeHealth = (
  overrides: Partial<ProtocolHealthInput> = {},
): ProtocolHealthInput => ({
  id: "blend",
  name: "Blend",
  status: "healthy",
  lastUpdatedAt: new Date(FIXED_NOW - 30_000).toISOString(),
  providerUptime: 0.99,
  recentErrorCount: 0,
  ...overrides,
});

describe("evaluateProtocolHealth", () => {
  it("marks fully healthy protocols as ok / not excluded", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth(),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.severity).toBe("ok");
    expect(evaluation.shouldExclude).toBe(false);
    expect(evaluation.reasons).toEqual([]);
  });

  it("excludes protocols whose status is in excludeStatuses", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth({ status: "down" }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.severity).toBe("fail");
    expect(evaluation.shouldExclude).toBe(true);
    expect(evaluation.reasons.join(" ")).toMatch(/status=down/);
  });

  it("warns but does not exclude on degraded status alone", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth({ status: "degraded" }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.severity).toBe("warn");
    expect(evaluation.shouldExclude).toBe(false);
  });

  it("excludes when data is older than maxDataAgeMs", () => {
    const stale = new Date(
      FIXED_NOW - DEFAULT_FAILOVER_THRESHOLDS.maxDataAgeMs - 1_000,
    ).toISOString();
    const evaluation = evaluateProtocolHealth(
      makeHealth({ lastUpdatedAt: stale }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.shouldExclude).toBe(true);
    expect(evaluation.reasons.join(" ")).toMatch(/stale/);
  });

  it("excludes when lastUpdatedAt is missing or invalid", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth({ lastUpdatedAt: "not-a-date" }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.shouldExclude).toBe(true);
    expect(evaluation.reasons.join(" ")).toMatch(/missing or invalid/);
  });

  it("excludes when uptime falls below the configured floor", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth({ providerUptime: 0.5 }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.shouldExclude).toBe(true);
    expect(evaluation.reasons.join(" ")).toMatch(/uptime/);
  });

  it("excludes when recentErrorCount exceeds the configured limit", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth({ recentErrorCount: 100 }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.shouldExclude).toBe(true);
    expect(evaluation.reasons.join(" ")).toMatch(/errorCount/);
  });

  it("ignores uptime field when it is not finite", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth({ providerUptime: Number.NaN }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.shouldExclude).toBe(false);
  });

  it("aggregates multiple failure reasons", () => {
    const evaluation = evaluateProtocolHealth(
      makeHealth({
        status: "critical",
        providerUptime: 0.1,
        recentErrorCount: 100,
      }),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(evaluation.reasons.length).toBeGreaterThanOrEqual(3);
    expect(evaluation.shouldExclude).toBe(true);
  });
});

describe("applyFailover", () => {
  const strategies = [
    { id: "blend", name: "Blend" },
    { id: "soroswap", name: "Soroswap" },
    { id: "defindex", name: "DeFindex" },
  ];

  it("includes healthy strategies and excludes degraded ones", () => {
    const health = new Map<string, ProtocolHealthInput>([
      ["blend", makeHealth({ id: "blend", status: "healthy" })],
      ["soroswap", makeHealth({ id: "soroswap", status: "down" })],
      ["defindex", makeHealth({ id: "defindex", status: "healthy" })],
    ]);
    const result = applyFailover(
      strategies,
      health,
      new Set(),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(result.included.map((s) => s.id)).toEqual(["blend", "defindex"]);
    expect(result.excluded.map((s) => s.id)).toEqual(["soroswap"]);
    const excludedDecision = result.decisions.find(
      (d) => d.protocolId === "soroswap" && d.action === "exclude",
    );
    expect(excludedDecision).toBeDefined();
  });

  it("logs a recovery decision when a previously-excluded protocol is healthy", () => {
    const health = new Map<string, ProtocolHealthInput>([
      ["blend", makeHealth({ id: "blend", status: "healthy" })],
      ["soroswap", makeHealth({ id: "soroswap", status: "healthy" })],
      ["defindex", makeHealth({ id: "defindex", status: "healthy" })],
    ]);
    const previous = new Set(["soroswap"]);
    const result = applyFailover(
      strategies,
      health,
      previous,
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(result.included.map((s) => s.id)).toContain("soroswap");
    const recovered = result.decisions.find(
      (d) => d.protocolId === "soroswap" && d.action === "recovered",
    );
    expect(recovered).toBeDefined();
  });

  it("excludes strategies that have no health data", () => {
    const health = new Map<string, ProtocolHealthInput>([
      ["blend", makeHealth({ id: "blend" })],
    ]);
    const result = applyFailover(
      strategies,
      health,
      new Set(),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(result.included.map((s) => s.id)).toEqual(["blend"]);
    expect(result.excluded.map((s) => s.id)).toEqual([
      "soroswap",
      "defindex",
    ]);
  });

  it("handles the partial-provider scenario (some healthy, some degraded, some missing)", () => {
    const health = new Map<string, ProtocolHealthInput>([
      ["blend", makeHealth({ id: "blend", status: "healthy" })],
      [
        "soroswap",
        makeHealth({ id: "soroswap", status: "degraded" }),
      ],
    ]);
    const result = applyFailover(
      strategies,
      health,
      new Set(),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(result.included.map((s) => s.id)).toEqual(["blend", "soroswap"]);
    expect(result.excluded.map((s) => s.id)).toEqual(["defindex"]);
  });

  it("returns one evaluation per strategy", () => {
    const health = new Map<string, ProtocolHealthInput>([
      ["blend", makeHealth({ id: "blend" })],
      ["soroswap", makeHealth({ id: "soroswap", status: "down" })],
      ["defindex", makeHealth({ id: "defindex" })],
    ]);
    const result = applyFailover(
      strategies,
      health,
      new Set(),
      DEFAULT_FAILOVER_THRESHOLDS,
      FIXED_NOW,
    );
    expect(result.evaluations).toHaveLength(strategies.length);
  });
});

describe("FailoverRegistry", () => {
  const strategies = [
    { id: "blend", name: "Blend" },
    { id: "soroswap", name: "Soroswap" },
  ];

  it("transitions from include → exclude → recovered across cycles", () => {
    const registry = new FailoverRegistry();

    const cycle1 = registry.apply(
      strategies,
      new Map([
        ["blend", makeHealth({ id: "blend" })],
        ["soroswap", makeHealth({ id: "soroswap" })],
      ]),
      FIXED_NOW,
    );
    expect(cycle1.excluded).toEqual([]);

    const cycle2 = registry.apply(
      strategies,
      new Map([
        ["blend", makeHealth({ id: "blend" })],
        [
          "soroswap",
          makeHealth({ id: "soroswap", status: "down" }),
        ],
      ]),
      FIXED_NOW + 1_000,
    );
    expect(cycle2.excluded.map((s) => s.id)).toEqual(["soroswap"]);
    expect(registry.excludedProtocols()).toEqual(["soroswap"]);

    const cycle3 = registry.apply(
      strategies,
      new Map([
        ["blend", makeHealth({ id: "blend" })],
        ["soroswap", makeHealth({ id: "soroswap" })],
      ]),
      FIXED_NOW + 2_000,
    );
    const recoveredDecision = cycle3.decisions.find(
      (d) => d.protocolId === "soroswap" && d.action === "recovered",
    );
    expect(recoveredDecision).toBeDefined();
    expect(registry.excludedProtocols()).toEqual([]);
  });

  it("returns recent decisions newest-first and respects the limit argument", () => {
    const registry = new FailoverRegistry();
    registry.apply(
      strategies,
      new Map([
        ["blend", makeHealth({ id: "blend" })],
        ["soroswap", makeHealth({ id: "soroswap", status: "down" })],
      ]),
      FIXED_NOW,
    );
    registry.apply(
      strategies,
      new Map([
        ["blend", makeHealth({ id: "blend", status: "down" })],
        ["soroswap", makeHealth({ id: "soroswap", status: "down" })],
      ]),
      FIXED_NOW + 1_000,
    );

    const recent = registry.recentDecisions(1);
    expect(recent).toHaveLength(1);
    // The most recent batch of decisions should be returned first.
    expect(recent[0].timestamp).toBe(
      new Date(FIXED_NOW + 1_000).toISOString(),
    );
  });

  it("returns no decisions when limit <= 0", () => {
    const registry = new FailoverRegistry();
    registry.apply(
      strategies,
      new Map([
        ["blend", makeHealth({ id: "blend" })],
        ["soroswap", makeHealth({ id: "soroswap", status: "down" })],
      ]),
      FIXED_NOW,
    );
    expect(registry.recentDecisions(0)).toEqual([]);
    expect(registry.recentDecisions(-5)).toEqual([]);
  });

  it("reset clears excluded set and decision log", () => {
    const registry = new FailoverRegistry();
    registry.apply(
      strategies,
      new Map([
        ["blend", makeHealth({ id: "blend" })],
        ["soroswap", makeHealth({ id: "soroswap", status: "down" })],
      ]),
      FIXED_NOW,
    );
    registry.reset();
    expect(registry.excludedProtocols()).toEqual([]);
    expect(registry.recentDecisions()).toEqual([]);
  });

  it("caps the decision log to its maximum size", () => {
    const registry = new FailoverRegistry();
    // Run enough cycles to exceed the log cap. Each cycle generates at
    // least one decision (one strategy excluded, one healthy).
    for (let i = 0; i < 600; i += 1) {
      registry.apply(
        strategies,
        new Map([
          ["blend", makeHealth({ id: "blend" })],
          ["soroswap", makeHealth({ id: "soroswap", status: "down" })],
        ]),
        FIXED_NOW + i * 1_000,
      );
    }
    // The bounded log should never exceed its cap.
    expect(registry.recentDecisions(1_000).length).toBeLessThanOrEqual(500);
  });
});
