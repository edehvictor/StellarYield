import {
  formatDryRunResult,
  parseDryRunInput,
  runDryRun,
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

  it("renders a JSON document by default", () => {
    const json = formatDryRunResult(sample(), "json");
    const parsed = JSON.parse(json);
    expect(parsed.decision.action).toBe("rotate");
    expect(parsed.policy.minScoreDifference).toBeGreaterThan(0);
    expect(typeof parsed.evaluatedAt).toBe("string");
  });

  it("renders human-readable text with a no-state-written footer", () => {
    const text = formatDryRunResult(sample(), "text");
    expect(text).toMatch(/Action:\s+ROTATE/);
    expect(text).toMatch(/No state was written/);
  });
});
