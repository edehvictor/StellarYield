import {
  validatePredictionInput,
  validatePredictionBatch,
  collectDiagnostics,
  MIN_HISTORICAL_DEPTH,
  STALE_THRESHOLD_MS,
  STALE_FETCH_THRESHOLD_MS,
  type PredictionInput,
  type TimeSeriesPoint,
} from "../services/predictionGuardrailsService";

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-25T12:00:00Z").getTime();

function makePoints(count: number, ageMs = 0): TimeSeriesPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(NOW - ageMs - i * 60_000).toISOString(),
    value: 5 + i * 0.1,
  }));
}

function freshInput(overrides: Partial<PredictionInput> = {}): PredictionInput {
  return {
    seriesId: "blend-apy",
    dataPoints: makePoints(MIN_HISTORICAL_DEPTH),
    lastFetchedAt: new Date(NOW - 1000).toISOString(),
    ...overrides,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe("guardrail constants", () => {
  it("MIN_HISTORICAL_DEPTH is 7", () => {
    expect(MIN_HISTORICAL_DEPTH).toBe(7);
  });

  it("STALE_THRESHOLD_MS is 30 minutes", () => {
    expect(STALE_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });

  it("STALE_FETCH_THRESHOLD_MS is 60 minutes", () => {
    expect(STALE_FETCH_THRESHOLD_MS).toBe(60 * 60 * 1000);
  });
});

// ── validatePredictionInput ───────────────────────────────────────────────────

describe("validatePredictionInput — depth checks", () => {
  it("passes with exactly MIN_HISTORICAL_DEPTH fresh data points", () => {
    const result = validatePredictionInput(freshInput(), NOW);
    expect(result.passed).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("passes with more than the minimum depth", () => {
    const result = validatePredictionInput(
      freshInput({ dataPoints: makePoints(30) }),
      NOW,
    );
    expect(result.passed).toBe(true);
  });

  it("errors when there are no data points", () => {
    const result = validatePredictionInput(
      freshInput({ dataPoints: [] }),
      NOW,
    );
    expect(result.passed).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("NO_DATA");
  });

  it("errors when depth is below the minimum threshold", () => {
    const result = validatePredictionInput(
      freshInput({ dataPoints: makePoints(MIN_HISTORICAL_DEPTH - 1) }),
      NOW,
    );
    expect(result.passed).toBe(false);
    const insufficient = result.diagnostics.find((d) => d.code === "INSUFFICIENT_DEPTH");
    expect(insufficient).toBeDefined();
    expect(insufficient?.severity).toBe("error");
    expect(insufficient?.message).toMatch(/at least 7/i);
  });

  it("INSUFFICIENT_DEPTH message includes actual depth and minimum", () => {
    const result = validatePredictionInput(
      freshInput({ dataPoints: makePoints(3) }),
      NOW,
    );
    const diag = result.diagnostics.find((d) => d.code === "INSUFFICIENT_DEPTH");
    expect(diag?.message).toContain("3");
    expect(diag?.message).toContain(String(MIN_HISTORICAL_DEPTH));
  });
});

describe("validatePredictionInput — stale data-point checks", () => {
  it("warns when the newest data point exceeds STALE_THRESHOLD_MS", () => {
    const staleAge = STALE_THRESHOLD_MS + 60_000; // 1 minute over threshold
    const result = validatePredictionInput(
      freshInput({ dataPoints: makePoints(MIN_HISTORICAL_DEPTH, staleAge) }),
      NOW,
    );
    expect(result.passed).toBe(true); // warn does not fail
    const stale = result.diagnostics.find((d) => d.code === "STALE_DATA");
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe("warn");
  });

  it("does not warn when the newest point is within the freshness window", () => {
    const freshAge = STALE_THRESHOLD_MS - 60_000; // 1 minute under threshold
    const result = validatePredictionInput(
      freshInput({ dataPoints: makePoints(MIN_HISTORICAL_DEPTH, freshAge) }),
      NOW,
    );
    expect(result.diagnostics.some((d) => d.code === "STALE_DATA")).toBe(false);
  });

  it("STALE_DATA message includes the data age and threshold in minutes", () => {
    const staleAge = STALE_THRESHOLD_MS + 5 * 60_000;
    const result = validatePredictionInput(
      freshInput({ dataPoints: makePoints(MIN_HISTORICAL_DEPTH, staleAge) }),
      NOW,
    );
    const diag = result.diagnostics.find((d) => d.code === "STALE_DATA");
    expect(diag?.message).toMatch(/minute/i);
  });

  it("errors on invalid timestamps in data points", () => {
    const result = validatePredictionInput(
      {
        seriesId: "bad-ts",
        dataPoints: [{ timestamp: "not-a-date", value: 5 }],
      },
      NOW,
    );
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "INVALID_TIMESTAMP")).toBe(true);
  });
});

describe("validatePredictionInput — stale fetch checks", () => {
  it("warns when lastFetchedAt exceeds STALE_FETCH_THRESHOLD_MS", () => {
    const staleFetchAge = STALE_FETCH_THRESHOLD_MS + 60_000;
    const result = validatePredictionInput(
      freshInput({
        lastFetchedAt: new Date(NOW - staleFetchAge).toISOString(),
      }),
      NOW,
    );
    const stale = result.diagnostics.find((d) => d.code === "STALE_FETCH");
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe("warn");
  });

  it("does not warn when lastFetchedAt is within the freshness window", () => {
    const result = validatePredictionInput(
      freshInput({
        lastFetchedAt: new Date(NOW - 5 * 60_000).toISOString(),
      }),
      NOW,
    );
    expect(result.diagnostics.some((d) => d.code === "STALE_FETCH")).toBe(false);
  });

  it("skips fetch-staleness check when lastFetchedAt is not provided", () => {
    const { lastFetchedAt: _, ...inputWithoutFetch } = freshInput();
    const result = validatePredictionInput(inputWithoutFetch, NOW);
    expect(result.diagnostics.some((d) => d.code === "STALE_FETCH")).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "INVALID_FETCH_TIMESTAMP")).toBe(false);
  });

  it("errors on invalid lastFetchedAt timestamp", () => {
    const result = validatePredictionInput(
      freshInput({ lastFetchedAt: "not-a-date" }),
      NOW,
    );
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "INVALID_FETCH_TIMESTAMP")).toBe(true);
  });
});

describe("validatePredictionInput — combined diagnostics", () => {
  it("can surface both INSUFFICIENT_DEPTH and STALE_DATA together", () => {
    const result = validatePredictionInput(
      {
        seriesId: "multi",
        dataPoints: makePoints(2, STALE_THRESHOLD_MS + 60_000),
        lastFetchedAt: new Date(NOW - 1000).toISOString(),
      },
      NOW,
    );
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("INSUFFICIENT_DEPTH");
    expect(codes).toContain("STALE_DATA");
    expect(result.passed).toBe(false);
  });

  it("passed flag is false when any diagnostic has severity error", () => {
    const result = validatePredictionInput(
      freshInput({ dataPoints: [] }),
      NOW,
    );
    expect(result.passed).toBe(false);
  });

  it("passed flag is true when diagnostics are only warnings", () => {
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const staleFetchAge = STALE_FETCH_THRESHOLD_MS + 60_000;
    const result = validatePredictionInput(
      {
        seriesId: "warn-only",
        dataPoints: makePoints(MIN_HISTORICAL_DEPTH, staleAge),
        lastFetchedAt: new Date(NOW - staleFetchAge).toISOString(),
      },
      NOW,
    );
    expect(result.passed).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.severity === "warn")).toBe(true);
  });

  it("result includes seriesId from the input", () => {
    const result = validatePredictionInput(freshInput({ seriesId: "my-series" }), NOW);
    expect(result.seriesId).toBe("my-series");
  });
});

// ── validatePredictionBatch ───────────────────────────────────────────────────

describe("validatePredictionBatch", () => {
  it("returns one result per input", () => {
    const inputs = [
      freshInput({ seriesId: "a" }),
      freshInput({ seriesId: "b" }),
      freshInput({ seriesId: "c" }),
    ];
    const { results } = validatePredictionBatch(inputs, NOW);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.seriesId)).toEqual(["a", "b", "c"]);
  });

  it("allPassed is true when all inputs pass", () => {
    const { allPassed } = validatePredictionBatch(
      [freshInput({ seriesId: "a" }), freshInput({ seriesId: "b" })],
      NOW,
    );
    expect(allPassed).toBe(true);
  });

  it("allPassed is false when any input fails", () => {
    const { allPassed } = validatePredictionBatch(
      [
        freshInput({ seriesId: "good" }),
        freshInput({ seriesId: "bad", dataPoints: [] }),
      ],
      NOW,
    );
    expect(allPassed).toBe(false);
  });

  it("handles an empty batch without throwing", () => {
    const { results, allPassed } = validatePredictionBatch([], NOW);
    expect(results).toHaveLength(0);
    expect(allPassed).toBe(true);
  });
});

// ── collectDiagnostics ────────────────────────────────────────────────────────

describe("collectDiagnostics", () => {
  const staleAge = STALE_THRESHOLD_MS + 60_000;
  const errorInput: PredictionInput = freshInput({ dataPoints: [] });
  const warnInput: PredictionInput = freshInput({
    seriesId: "warn",
    dataPoints: makePoints(MIN_HISTORICAL_DEPTH, staleAge),
  });

  it("collects all diagnostics across results by default", () => {
    const results = [
      validatePredictionInput(errorInput, NOW),
      validatePredictionInput(warnInput, NOW),
    ];
    const all = collectDiagnostics(results);
    const codes = all.map((d) => d.code);
    expect(codes).toContain("NO_DATA");
    expect(codes).toContain("STALE_DATA");
  });

  it("filters to only error-severity diagnostics when minSeverity is error", () => {
    const results = [
      validatePredictionInput(errorInput, NOW),
      validatePredictionInput(warnInput, NOW),
    ];
    const errors = collectDiagnostics(results, "error");
    expect(errors.every((d) => d.severity === "error")).toBe(true);
    expect(errors.some((d) => d.code === "NO_DATA")).toBe(true);
    expect(errors.some((d) => d.code === "STALE_DATA")).toBe(false);
  });

  it("returns empty array when all inputs are clean", () => {
    const results = [validatePredictionInput(freshInput(), NOW)];
    expect(collectDiagnostics(results)).toHaveLength(0);
  });
});
