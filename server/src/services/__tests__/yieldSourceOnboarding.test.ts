import {
  validateYieldSourceOnboarding,
  YieldSourceOnboardingError,
  REQUIRED_ONBOARDING_FIELDS,
  type YieldSourceOnboardingInput,
} from "../yieldSourceOnboardingService";
import {
  REGISTERED_SOURCES,
  listYieldSources,
  promoteYieldSource,
  unregisterYieldSource,
  getSourceHealthRegistry,
  type YieldSourceRegistryEntry,
} from "../yieldSourceRegistryService";

function validEntry(
  overrides: Partial<YieldSourceRegistryEntry> = {},
): YieldSourceRegistryEntry {
  return {
    id: "new_source",
    name: "New Source",
    source: "api",
    onboarding: {
      protocol: "Blend",
      asset: "USDC",
      fee: { managementBps: 0, performanceBps: 100 },
      risk: { level: "Low" },
      freshness: { maxAgeSeconds: 900 },
    },
    ...overrides,
  };
}

describe("validateYieldSourceOnboarding", () => {
  it("passes every existing registered source unchanged (#1156)", () => {
    for (const entry of REGISTERED_SOURCES) {
      const result = validateYieldSourceOnboarding(entry);
      expect(result.valid).toBe(true);
      expect(result.missingFields).toEqual([]);
      expect(result.issues).toEqual([]);
    }
  });

  it("names every missing required field when onboarding metadata is absent", () => {
    const result = validateYieldSourceOnboarding({
      id: "incomplete_source",
      name: "Incomplete Source",
      source: "api",
    });

    expect(result.valid).toBe(false);
    for (const field of REQUIRED_ONBOARDING_FIELDS) {
      expect(result.missingFields).toContain(`onboarding.${field}`);
      expect(result.message).toContain(`onboarding.${field}`);
    }
  });

  it("reports only the sections that are actually missing", () => {
    const result = validateYieldSourceOnboarding({
      id: "partial_source",
      name: "Partial Source",
      source: "api",
      onboarding: {
        protocol: "Blend",
        asset: "USDC",
      },
    });

    expect(result.valid).toBe(false);
    expect(result.missingFields).toEqual([
      "onboarding.fee",
      "onboarding.risk",
      "onboarding.freshness",
    ]);
    expect(result.missingFields).not.toContain("onboarding.protocol");
    expect(result.missingFields).not.toContain("onboarding.asset");
  });

  it("reports missing nested leaf fields individually", () => {
    const result = validateYieldSourceOnboarding({
      id: "nested_source",
      name: "Nested Source",
      source: "api",
      onboarding: {
        protocol: "Blend",
        asset: "USDC",
        fee: { managementBps: 0 },
        risk: { level: "Low" },
        freshness: { maxAgeSeconds: 900 },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.missingFields).toEqual(["onboarding.fee.performanceBps"]);
  });

  it("flags inconsistent fee, risk, and freshness values with actionable messages", () => {
    const result = validateYieldSourceOnboarding({
      id: "bad_values",
      name: "Bad Values",
      source: "api",
      onboarding: {
        protocol: "Blend",
        asset: "USDC",
        fee: { managementBps: -1, performanceBps: 20_000 },
        risk: { level: "Extreme", score: 150 },
        freshness: { maxAgeSeconds: 0 },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.missingFields).toEqual([]);

    const fields = result.issues.map((issue) => issue.field);
    expect(fields).toContain("onboarding.fee.managementBps");
    expect(fields).toContain("onboarding.fee.performanceBps");
    expect(fields).toContain("onboarding.risk.level");
    expect(fields).toContain("onboarding.risk.score");
    expect(fields).toContain("onboarding.freshness.maxAgeSeconds");

    for (const issue of result.issues) {
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.message).toContain(issue.field);
    }
    expect(result.message).toContain("failed the onboarding checklist");
  });

  it("accepts zero fees for sources that charge nothing", () => {
    const result = validateYieldSourceOnboarding({
      id: "free_oracle",
      name: "Free Oracle",
      source: "oracle",
      onboarding: {
        protocol: "Market Data",
        asset: "USDC",
        fee: { managementBps: 0, performanceBps: 0 },
        risk: { level: "Low", score: 10 },
        freshness: { maxAgeSeconds: 3600 },
      },
    });

    expect(result.valid).toBe(true);
  });
});

describe("promoteYieldSource", () => {
  it("promotes a complete entry and exposes it to production routes", async () => {
    const entry = validEntry({ id: "promoted_source", name: "Promoted Source" });

    const promoted = promoteYieldSource(entry);
    expect(promoted.id).toBe("promoted_source");
    expect(listYieldSources().map((source) => source.id)).toContain(
      "promoted_source",
    );

    const registry = await getSourceHealthRegistry();
    expect(registry.onboarding.status).toBe("valid");
    expect(registry.sources.map((source) => source.providerId)).toContain(
      "promoted_source",
    );

    expect(unregisterYieldSource("promoted_source")).toBe(true);
    expect(listYieldSources().map((source) => source.id)).not.toContain(
      "promoted_source",
    );

    const after = await getSourceHealthRegistry();
    expect(after.sources.map((source) => source.providerId)).not.toContain(
      "promoted_source",
    );
  });

  it("refuses an incomplete entry, naming every missing field, and does not add it", () => {
    const entry: YieldSourceRegistryEntry = {
      id: "blocked_source",
      name: "Blocked Source",
      source: "api",
    };

    let caught: unknown;
    try {
      promoteYieldSource(entry);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(YieldSourceOnboardingError);
    const error = caught as YieldSourceOnboardingError;
    expect(error.code).toBe("ONBOARDING_CHECKLIST_FAILED");
    expect(error.statusCode).toBe(400);
    for (const field of REQUIRED_ONBOARDING_FIELDS) {
      expect(error.details.missingFields).toContain(`onboarding.${field}`);
      expect(error.message).toContain(`onboarding.${field}`);
    }
    expect(listYieldSources().map((source) => source.id)).not.toContain(
      "blocked_source",
    );
  });

  it("rejects a duplicate provider id", () => {
    let caught: unknown;
    try {
      promoteYieldSource(validEntry({ id: "blend_api" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(YieldSourceOnboardingError);
    const error = caught as YieldSourceOnboardingError;
    expect(error.code).toBe("YIELD_SOURCE_ALREADY_REGISTERED");
    expect(error.statusCode).toBe(409);
    expect(unregisterYieldSource("blend_api")).toBe(false);
  });
});

describe("getSourceHealthRegistry onboarding gate", () => {
  it("excludes incomplete registered entries and reports them with reasons", async () => {
    REGISTERED_SOURCES.push({
      id: "incomplete_registered",
      name: "Incomplete Registered",
      source: "api",
    });

    try {
      const registry = await getSourceHealthRegistry();

      expect(registry.onboarding.status).toBe("incomplete");
      expect(
        registry.sources.map((source) => source.providerId),
      ).not.toContain("incomplete_registered");

      const reported = registry.onboarding.incompleteSources.find(
        (entry) => entry.id === "incomplete_registered",
      );
      expect(reported).toBeDefined();
      expect(reported?.missingFields).toEqual(
        expect.arrayContaining(
          REQUIRED_ONBOARDING_FIELDS.map((field) => `onboarding.${field}`),
        ),
      );
      expect(reported?.message).toContain("failed the onboarding checklist");
    } finally {
      const index = REGISTERED_SOURCES.findIndex(
        (entry) => entry.id === "incomplete_registered",
      );
      if (index !== -1) REGISTERED_SOURCES.splice(index, 1);
      // Restore a clean cached registry for any later assertions.
      await getSourceHealthRegistry();
    }

    const clean = await getSourceHealthRegistry();
    expect(clean.onboarding.status).toBe("valid");
    expect(clean.onboarding.incompleteSources).toEqual([]);
  });

  it("keeps all static sources visible while the gate is active", async () => {
    const registry = await getSourceHealthRegistry();
    const ids = registry.sources.map((source) => source.providerId);

    for (const entry of REGISTERED_SOURCES) {
      expect(ids).toContain(entry.id);
    }
    expect(registry.totalSources).toBeGreaterThan(0);
  });
});

describe("validateYieldSourceOnboarding input tolerance", () => {
  it("treats a missing entry and non-object onboarding safely", () => {
    const missingEntry = validateYieldSourceOnboarding(
      undefined as unknown as YieldSourceOnboardingInput,
    );
    expect(missingEntry.valid).toBe(false);
    expect(missingEntry.missingFields).toEqual(
      expect.arrayContaining(["id", "name", "source"]),
    );

    const badOnboarding = validateYieldSourceOnboarding({
      id: "x",
      name: "X",
      source: "api",
      onboarding: "not-an-object",
    });
    expect(badOnboarding.valid).toBe(false);
    expect(badOnboarding.missingFields).toEqual(
      expect.arrayContaining(
        REQUIRED_ONBOARDING_FIELDS.map((field) => `onboarding.${field}`),
      ),
    );
  });
});
