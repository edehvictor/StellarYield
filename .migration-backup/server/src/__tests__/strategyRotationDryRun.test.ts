import {
  buildStrategyDiff,
  formatDryRunResult,
  parseDryRunInput,
  runDryRun,
  type StrategyStateSnapshot,
} from "../services/strategyRotationDryRun";
import { rotationRegistry } from "../services/strategyRotationService";

const FIXED_NOW_ISO = "2026-04-28T12:00:00Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);

const candidateAt = (offsetMs: number, overrides: Record<string, unknown> = {}) => ({
  id: "soroswap",
  name: "Soroswap",
  score: 5,
  volatility: 2,
  confidence: 0.9,
  fetchedAt: new Date(FIXED_NOW_MS - offsetMs).toISOString(),
  ...overrides,
});

describe("parseDryRunInput", () => {
  it("rejects a top-level non-object payload", () => {
    expect(() => parseDryRunInput(null)).toThrow(TypeError);
    expect(() => parseDryRunInput([])).toThrow(TypeError);
    expect(() => parseDryRunInput("nope")).toThrow(TypeError);
  });

  it("rejects payloads missing a candidates array", () => {
    expect(() =>
      parseDryRunInput({ context: { currentId: null } }),
    ).toThrow(/candidates/);
  });

  it("rejects candidates with non-finite scores", () => {
    expect(() =>
      parseDryRunInput({
        context: {
          candidates: [
            { id: "blend", score: Number.NaN, fetchedAt: FIXED_NOW_ISO },
          ],
        },
      }),
    ).toThrow(/score/);
  });

  it("accepts a minimal valid input", () => {
    const parsed = parseDryRunInput({
      context: {
        candidates: [
          { id: "blend", score: 1, fetchedAt: FIXED_NOW_ISO, name: "Blend" },
        ],
      },
    });
    expect(parsed.context.candidates).toHaveLength(1);
    expect(parsed.context.currentId).toBeNull();
    expect(parsed.policy).toBeUndefined();
  });
});

describe("runDryRun", () => {
  it("returns hold/no_candidates when context has none", () => {
    const result = runDryRun({
      context: {
        currentId: null,
        currentScore: null,
        lastRotatedAt: null,
        candidates: [],
      },
      now: FIXED_NOW_ISO,
    });
    expect(result.decision.action).toBe("hold");
    expect(result.decision.reason).toBe("no_candidates");
  });

  it("rotates into the best candidate when no incumbent exists", () => {
    const result = runDryRun({
      context: {
        currentId: null,
        currentScore: null,
        lastRotatedAt: null,
        candidates: [candidateAt(60_000, { score: 5 })],
      },
      now: FIXED_NOW_ISO,
    });
    expect(result.decision.action).toBe("rotate");
    expect(result.decision.toId).toBe("soroswap");
  });

  it("honours an overridden policy threshold (skip case)", () => {
    const result = runDryRun({
      context: {
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [candidateAt(60_000, { id: "soroswap", score: 5.4 })],
      },
      policy: { minScoreDifference: 1.0 },
      now: FIXED_NOW_ISO,
    });
    expect(result.decision.action).toBe("hold");
    expect(result.decision.reason).toBe("candidate_below_threshold");
    expect(result.policy.minScoreDifference).toBe(1.0);
  });

  it("does not mutate the shared rotation registry", () => {
    const before = rotationRegistry.current();
    runDryRun({
      context: {
        currentId: null,
        currentScore: null,
        lastRotatedAt: null,
        candidates: [candidateAt(60_000, { score: 9 })],
      },
      now: FIXED_NOW_ISO,
    });
    const after = rotationRegistry.current();
    expect(after).toEqual(before);
  });
});

describe("formatDryRunResult", () => {
  const sample = () =>
    runDryRun({
      context: {
        currentId: null,
        currentScore: null,
        lastRotatedAt: null,
        candidates: [candidateAt(60_000, { score: 9 })],
      },
      now: FIXED_NOW_ISO,
    });

  // A hold decision leaves every field untouched, so its diff is a no-op.
  const holdSample = () =>
    runDryRun({
      context: {
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          candidateAt(60_000, { id: "blend", score: 5 }),
          candidateAt(60_000, { id: "soroswap", score: 5.2 }),
        ],
      },
      now: FIXED_NOW_ISO,
    });

  it("renders a JSON document by default", () => {
    const json = formatDryRunResult(sample(), "json");
    const parsed = JSON.parse(json);
    expect(parsed.decision.action).toBe("rotate");
    expect(parsed.policy.minScoreDifference).toBeGreaterThan(0);
    expect(typeof parsed.evaluatedAt).toBe("string");
    expect(parsed.diff).toBeDefined();
    expect(typeof parsed.diff.noOp).toBe("boolean");
  });

  it("renders human-readable text with a no-state-written footer", () => {
    const text = formatDryRunResult(sample(), "text");
    expect(text).toMatch(/Action:\s+ROTATE/);
    expect(text).toMatch(/No state was written/);
  });

  it("reports no-op dry runs as such in text output", () => {
    const text = formatDryRunResult(holdSample(), "text");
    expect(text).toMatch(/State delta:/);
    expect(text).toMatch(/no-op/);
    expect(text).not.toMatch(/Changed thresholds/);
  });

  it("renders a structured no-op diff in JSON output", () => {
    const parsed = JSON.parse(formatDryRunResult(holdSample(), "json"));
    expect(parsed.diff.noOp).toBe(true);
    expect(parsed.diff.changeCount).toBe(0);
    expect(parsed.diff.additions).toEqual([]);
    expect(parsed.diff.removals).toEqual([]);
    expect(parsed.diff.weightChanges).toEqual([]);
    expect(parsed.diff.thresholdChanges).toEqual([]);
    expect(parsed.diff.incumbentChanges).toEqual([]);
  });

  it("renders the state delta for a rotation in text output", () => {
    const text = formatDryRunResult(sample(), "text");
    expect(text).toMatch(/State delta \(3 changes\):/);
    expect(text).toMatch(/Incumbent:/);
    expect(text).toMatch(/currentId: \(none\) -> soroswap/);
  });
});

describe("buildStrategyDiff", () => {
  const snapshot = (overrides: Partial<StrategyStateSnapshot> = {}): StrategyStateSnapshot => ({
    currentId: null,
    currentScore: null,
    lastRotatedAt: null,
    strategies: [],
    policy: {
      minScoreDifference: 0.5,
      cooldownMs: 86_400_000,
      maxDataAgeMs: 600_000,
      minConfidence: 0.7,
    },
    ...overrides,
  });

  const weight = (overrides: Record<string, unknown> = {}) => ({
    id: "blend",
    name: "Blend",
    score: 5,
    volatility: 2,
    confidence: 0.9,
    ...overrides,
  });

  it("produces an empty (no-op) diff for identical snapshots", () => {
    const current = snapshot({ strategies: [weight()] });
    const diff = buildStrategyDiff(current, snapshot({ strategies: [weight()] }));
    expect(diff.noOp).toBe(true);
    expect(diff.changeCount).toBe(0);
    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.weightChanges).toEqual([]);
    expect(diff.thresholdChanges).toEqual([]);
    expect(diff.incumbentChanges).toEqual([]);
  });

  it("recognizes a single-field diff (one changed weight)", () => {
    const current = snapshot({ strategies: [weight({ score: 5 })] });
    const proposed = snapshot({ strategies: [weight({ score: 7 })] });
    const diff = buildStrategyDiff(current, proposed);
    expect(diff.noOp).toBe(false);
    expect(diff.changeCount).toBe(1);
    expect(diff.weightChanges).toEqual([
      { id: "blend", name: "Blend", field: "score", from: 5, to: 7 },
    ]);
    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
  });

  it("recognizes a single-field diff (one changed threshold)", () => {
    const current = snapshot();
    const proposed = snapshot({
      policy: { ...current.policy, minScoreDifference: 1.0 },
    });
    const diff = buildStrategyDiff(current, proposed);
    expect(diff.noOp).toBe(false);
    expect(diff.changeCount).toBe(1);
    expect(diff.thresholdChanges).toEqual([
      { field: "minScoreDifference", from: 0.5, to: 1.0 },
    ]);
  });

  it("recognizes a single-field diff (one changed incumbent field)", () => {
    const current = snapshot({ currentId: "blend", currentScore: 5 });
    const proposed = snapshot({ currentId: "soroswap", currentScore: 5 });
    const diff = buildStrategyDiff(current, proposed);
    expect(diff.noOp).toBe(false);
    expect(diff.changeCount).toBe(1);
    expect(diff.incumbentChanges).toEqual([
      { field: "currentId", from: "blend", to: "soroswap" },
    ]);
  });

  it("detects multi-step diffs across all change categories", () => {
    const current = snapshot({
      currentId: "blend",
      currentScore: 5,
      strategies: [
        weight({ id: "blend", score: 5 }),
        weight({ id: "soroswap", score: 4 }),
        weight({ id: "legacy", score: 3 }),
      ],
    });
    const proposed = snapshot({
      currentId: "soroswap",
      currentScore: 7,
      strategies: [
        weight({ id: "soroswap", name: "Soroswap", score: 7 }),
        weight({ id: "blend", score: 5 }),
        weight({ id: "brandnew", score: 6 }),
      ],
      policy: { ...current.policy, minConfidence: 0.8 },
    });

    const diff = buildStrategyDiff(current, proposed);
    expect(diff.noOp).toBe(false);
    expect(diff.changeCount).toBeGreaterThanOrEqual(5);

    // Additions / removals by id.
    expect(diff.additions.map((s) => s.id)).toEqual(["brandnew"]);
    expect(diff.removals.map((s) => s.id)).toEqual(["legacy"]);

    // Weight change for the strategy present in both with a different score.
    expect(diff.weightChanges).toEqual([
      { id: "soroswap", name: "Soroswap", field: "score", from: 4, to: 7 },
    ]);

    // Threshold change.
    expect(diff.thresholdChanges).toEqual([
      { field: "minConfidence", from: 0.7, to: 0.8 },
    ]);

    // Incumbent field changes.
    expect(diff.incumbentChanges).toEqual([
      { field: "currentId", from: "blend", to: "soroswap" },
      { field: "currentScore", from: 5, to: 7 },
    ]);
  });

  it("flags a field that is added to a strategy (absent -> present)", () => {
    const current = snapshot({ strategies: [weight({ volatility: undefined })] });
    const proposed = snapshot({ strategies: [weight({ volatility: 2 })] });
    const diff = buildStrategyDiff(current, proposed);
    expect(diff.weightChanges).toEqual([
      { id: "blend", name: "Blend", field: "volatility", from: null, to: 2 },
    ]);
    expect(diff.noOp).toBe(false);
  });
});

describe("runDryRun diff integration", () => {
  it("returns an empty (no-op) diff when the decision is hold", () => {
    const result = runDryRun({
      context: {
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          candidateAt(60_000, { id: "blend", score: 5 }),
          candidateAt(60_000, { id: "soroswap", score: 5.2 }),
        ],
      },
      now: FIXED_NOW_ISO,
    });
    expect(result.decision.action).toBe("hold");
    expect(result.diff.noOp).toBe(true);
    expect(result.diff.changeCount).toBe(0);
  });

  it("surfaces incumbent changes for a rotation", () => {
    const result = runDryRun({
      context: {
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          candidateAt(60_000, { id: "blend", score: 5 }),
          candidateAt(60_000, { id: "soroswap", score: 7 }),
        ],
      },
      now: FIXED_NOW_ISO,
    });
    expect(result.decision.action).toBe("rotate");
    expect(result.diff.noOp).toBe(false);
    expect(result.diff.incumbentChanges.map((c) => c.field)).toEqual([
      "currentId",
      "currentScore",
      "lastRotatedAt",
    ]);
  });

  it("surfaces threshold changes when a policy override is proposed", () => {
    const result = runDryRun({
      context: {
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          candidateAt(60_000, { id: "blend", score: 5 }),
          candidateAt(60_000, { id: "soroswap", score: 7 }),
        ],
      },
      policy: { minScoreDifference: 1.0 },
      now: FIXED_NOW_ISO,
    });
    expect(result.diff.thresholdChanges).toEqual([
      { field: "minScoreDifference", from: 0.5, to: 1.0 },
    ]);
  });

  it("flags additions, removals, and weight changes from currentStrategies", () => {
    const result = runDryRun({
      context: {
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          candidateAt(60_000, { id: "blend", score: 5 }),
          candidateAt(60_000, { id: "soroswap", score: 6.5 }),
          candidateAt(60_000, { id: "brandnew", score: 6 }),
        ],
      },
      currentStrategies: [
        { id: "blend", name: "Blend", score: 5, volatility: 2, confidence: 0.9 },
        { id: "soroswap", name: "Soroswap", score: 4, volatility: 2, confidence: 0.9 },
        { id: "legacy", name: "Legacy", score: 3, volatility: 2, confidence: 0.9 },
      ],
      now: FIXED_NOW_ISO,
    });
    expect(result.diff.additions.map((s) => s.id)).toEqual(["brandnew"]);
    expect(result.diff.removals.map((s) => s.id)).toEqual(["legacy"]);
    expect(result.diff.weightChanges).toEqual([
      { id: "soroswap", name: "Soroswap", field: "score", from: 4, to: 6.5 },
    ]);
    expect(result.diff.noOp).toBe(false);
  });
});

describe("parseDryRunInput currentStrategies", () => {
  it("accepts a valid currentStrategies array", () => {
    const parsed = parseDryRunInput({
      context: {
        candidates: [{ id: "blend", score: 5, fetchedAt: FIXED_NOW_ISO, name: "Blend" }],
      },
      currentStrategies: [
        { id: "blend", name: "Blend", score: 4, volatility: 2, confidence: 0.8 },
      ],
    });
    expect(parsed.currentStrategies).toEqual([
      { id: "blend", name: "Blend", score: 4, volatility: 2, confidence: 0.8 },
    ]);
  });

  it("rejects currentStrategies with an invalid entry", () => {
    expect(() =>
      parseDryRunInput({
        context: {
          candidates: [{ id: "blend", score: 5, fetchedAt: FIXED_NOW_ISO }],
        },
        currentStrategies: [{ id: "", score: 5 }],
      }),
    ).toThrow(/currentStrategies\[0\].id/);

    expect(() =>
      parseDryRunInput({
        context: {
          candidates: [{ id: "blend", score: 5, fetchedAt: FIXED_NOW_ISO }],
        },
        currentStrategies: [{ id: "blend", score: Number.NaN }],
      }),
    ).toThrow(/currentStrategies\[0\].score/);
  });

  it("leaves currentStrategies undefined when omitted", () => {
    const parsed = parseDryRunInput({
      context: {
        candidates: [{ id: "blend", score: 5, fetchedAt: FIXED_NOW_ISO }],
      },
    });
    expect(parsed.currentStrategies).toBeUndefined();
  });
});
