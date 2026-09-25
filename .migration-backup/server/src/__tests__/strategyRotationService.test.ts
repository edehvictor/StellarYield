import {
  DEFAULT_ROTATION_POLICY,
  evaluateRotation,
  rotationRegistry,
  RotationRegistry,
  type RotationCandidate,
  type RotationContext,
  type RotationPolicy,
} from "../services/strategyRotationService";
import { runRotationCycle } from "../jobs/strategyRotationJob";

const FIXED_NOW = Date.parse("2026-04-28T12:00:00Z");

const makeCandidate = (
  overrides: Partial<RotationCandidate> = {},
): RotationCandidate => ({
  id: "blend",
  name: "Blend",
  score: 1.0,
  volatility: 2,
  confidence: 0.9,
  fetchedAt: new Date(FIXED_NOW - 60_000).toISOString(),
  ...overrides,
});

const makeContext = (
  overrides: Partial<RotationContext> = {},
): RotationContext => ({
  currentId: null,
  currentScore: null,
  lastRotatedAt: null,
  candidates: [],
  ...overrides,
});

describe("evaluateRotation", () => {
  it("returns hold/no_candidates when there are no candidates", () => {
    const decision = evaluateRotation(makeContext(), DEFAULT_ROTATION_POLICY, FIXED_NOW);
    expect(decision.action).toBe("hold");
    expect(decision.reason).toBe("no_candidates");
  });

  it("rotates into a strategy when no incumbent is set", () => {
    const decision = evaluateRotation(
      makeContext({ candidates: [makeCandidate({ id: "blend", score: 5 })] }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.action).toBe("rotate");
    expect(decision.reason).toBe("no_current_strategy");
    expect(decision.toId).toBe("blend");
  });

  it("holds when the incumbent is inside its cooldown window", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW - 60_000).toISOString(),
        candidates: [
          makeCandidate({ id: "blend", score: 5 }),
          makeCandidate({ id: "soroswap", score: 999 }),
        ],
      }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.action).toBe("hold");
    expect(decision.reason).toBe("current_in_cooldown");
  });

  it("does not rotate when no candidate clears the minScoreDifference", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          makeCandidate({ id: "blend", score: 5 }),
          makeCandidate({ id: "soroswap", score: 5.2 }),
        ],
      }),
      { ...DEFAULT_ROTATION_POLICY, minScoreDifference: 0.5 },
      FIXED_NOW,
    );
    expect(decision.action).toBe("hold");
    expect(decision.reason).toBe("candidate_below_threshold");
    expect(decision.scoreDelta).toBeCloseTo(0.2);
  });

  it("rotates when a candidate clears the minScoreDifference", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          makeCandidate({ id: "blend", score: 5 }),
          makeCandidate({ id: "soroswap", score: 7 }),
        ],
      }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.action).toBe("rotate");
    expect(decision.reason).toBe("candidate_better");
    expect(decision.toId).toBe("soroswap");
    expect(decision.scoreDelta).toBeCloseTo(2);
  });

  it("skips candidates with stale data", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          makeCandidate({
            id: "soroswap",
            score: 999,
            fetchedAt: new Date(FIXED_NOW - 60 * 60 * 1000).toISOString(),
          }),
        ],
      }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.action).toBe("hold");
    expect(decision.reason).toBe("candidate_data_stale");
  });

  it("skips candidates with confidence below the floor", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [makeCandidate({ id: "soroswap", score: 999, confidence: 0.1 })],
      }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.action).toBe("hold");
    expect(decision.reason).toBe("candidate_low_confidence");
  });

  it("ties: chooses higher confidence when scores are equal", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: null,
        currentScore: null,
        candidates: [
          makeCandidate({ id: "a", score: 9, confidence: 0.8 }),
          makeCandidate({ id: "b", score: 9, confidence: 0.95 }),
        ],
      }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.toId).toBe("b");
  });

  it("ties: chooses lower volatility when score and confidence are equal", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: null,
        currentScore: null,
        candidates: [
          makeCandidate({ id: "a", score: 9, confidence: 0.9, volatility: 5 }),
          makeCandidate({ id: "b", score: 9, confidence: 0.9, volatility: 1 }),
        ],
      }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.toId).toBe("b");
  });

  it("ties: deterministic alphabetical tiebreaker", () => {
    const decision = evaluateRotation(
      makeContext({
        currentId: null,
        currentScore: null,
        candidates: [
          makeCandidate({ id: "z", score: 9, confidence: 0.9, volatility: 1 }),
          makeCandidate({ id: "a", score: 9, confidence: 0.9, volatility: 1 }),
        ],
      }),
      DEFAULT_ROTATION_POLICY,
      FIXED_NOW,
    );
    expect(decision.toId).toBe("a");
  });

  it("emits the most informative skip reason when all candidates are filtered", () => {
    const policy: RotationPolicy = {
      ...DEFAULT_ROTATION_POLICY,
      maxDataAgeMs: 1_000,
      minConfidence: 0.99,
    };
    const decision = evaluateRotation(
      makeContext({
        currentId: "blend",
        currentScore: 5,
        lastRotatedAt: new Date(FIXED_NOW - 48 * 60 * 60 * 1000).toISOString(),
        candidates: [
          makeCandidate({
            id: "stale",
            score: 99,
            fetchedAt: new Date(FIXED_NOW - 60 * 60 * 1000).toISOString(),
          }),
          makeCandidate({
            id: "lowconf",
            score: 99,
            confidence: 0.1,
          }),
        ],
      }),
      policy,
      FIXED_NOW,
    );
    expect(decision.action).toBe("hold");
    expect(["candidate_data_stale", "candidate_low_confidence"]).toContain(
      decision.reason,
    );
  });
});

describe("RotationRegistry", () => {
  it("rotates initial allocation, then enters cooldown", () => {
    const registry = new RotationRegistry();
    const initial = registry.evaluate(
      [makeCandidate({ id: "blend", score: 5 })],
      FIXED_NOW,
    );
    expect(initial.action).toBe("rotate");
    expect(registry.current().id).toBe("blend");

    const second = registry.evaluate(
      [
        makeCandidate({ id: "blend", score: 5 }),
        makeCandidate({ id: "soroswap", score: 999 }),
      ],
      FIXED_NOW + 60_000,
    );
    expect(second.action).toBe("hold");
    expect(second.reason).toBe("current_in_cooldown");
  });

  it("rotates again once the cooldown has elapsed and threshold is met", () => {
    const registry = new RotationRegistry();
    registry.evaluate([makeCandidate({ id: "blend", score: 5 })], FIXED_NOW);

    const future = FIXED_NOW + DEFAULT_ROTATION_POLICY.cooldownMs + 1_000;
    const decision = registry.evaluate(
      [
        makeCandidate({
          id: "blend",
          score: 5,
          fetchedAt: new Date(future - 60_000).toISOString(),
        }),
        makeCandidate({
          id: "soroswap",
          score: 9,
          fetchedAt: new Date(future - 60_000).toISOString(),
        }),
      ],
      future,
    );
    expect(decision.action).toBe("rotate");
    expect(decision.toId).toBe("soroswap");
    expect(registry.current().id).toBe("soroswap");
  });

  it("records both rotate and hold decisions in history, newest first", () => {
    const registry = new RotationRegistry();
    registry.evaluate([makeCandidate({ id: "blend", score: 5 })], FIXED_NOW);
    registry.evaluate(
      [
        makeCandidate({ id: "blend", score: 5 }),
        makeCandidate({ id: "soroswap", score: 999 }),
      ],
      FIXED_NOW + 1_000,
    );
    const recent = registry.recentDecisions(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].evaluatedAt > recent[1].evaluatedAt).toBe(true);
  });

  it("reset clears state and history", () => {
    const registry = new RotationRegistry();
    registry.evaluate([makeCandidate({ id: "blend", score: 5 })], FIXED_NOW);
    registry.reset();
    expect(registry.current().id).toBeNull();
    expect(registry.recentDecisions()).toEqual([]);
  });

  it("recentDecisions(0) returns empty array", () => {
    const registry = new RotationRegistry();
    registry.evaluate([makeCandidate({ id: "blend", score: 5 })], FIXED_NOW);
    expect(registry.recentDecisions(0)).toEqual([]);
  });
});

describe("runRotationCycle", () => {
  beforeEach(() => {
    rotationRegistry.reset();
  });

  it("invokes onDecision for every cycle and onRotation only for rotates", async () => {
    let decisions = 0;
    let rotations = 0;

    const decision = await runRotationCycle({
      fetchCandidates: async () => [
        makeCandidate({
          id: "blend",
          score: 5,
          fetchedAt: new Date().toISOString(),
        }),
      ],
      onDecision: () => {
        decisions += 1;
      },
      onRotation: () => {
        rotations += 1;
      },
    });
    expect(decision.action).toBe("rotate");
    expect(decisions).toBe(1);
    expect(rotations).toBe(1);
  });

  it("does not call onRotation when the action is hold", async () => {
    let rotations = 0;
    const decision = await runRotationCycle({
      fetchCandidates: async () => [],
      onRotation: () => {
        rotations += 1;
      },
    });
    expect(decision.action).toBe("hold");
    expect(rotations).toBe(0);
  });
});
