import {
  validatePolicy,
  storePolicy,
  getPolicy,
  listPolicies,
  deletePolicy,
  updatePolicy,
  resetPolicyStore,
  evaluatePolicy,
  markRuleExecuted,
  type AllocationPolicy,
  type PolicyEvaluationContext,
} from "../services/allocationPolicyDsl";

const VALID_POLICY = {
  name: "Balanced Allocation",
  version: "1.0.0",
  description: "A balanced allocation policy for stable returns",
  rules: [
    {
      id: "high-yield-stable",
      description: "High yield with low volatility",
      weight: 0.6,
      conditions: {
        minTvl: 1_000_000,
        maxVolatility: 15,
        minApy: 5,
      },
      cooldown: {
        durationMs: 3600000,
      },
      threshold: {
        max: 70,
      },
    },
    {
      id: "growth-focused",
      description: "Growth with higher volatility tolerance",
      weight: 0.4,
      conditions: {
        minTvl: 500_000,
        maxVolatility: 30,
        minApy: 8,
      },
      threshold: {
        min: 10,
        max: 50,
      },
    },
  ],
  defaultRule: {
    conditions: {
      maxVolatility: 50,
    },
  },
};

describe("validatePolicy", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("accepts a valid policy definition", () => {
    const result = validatePolicy(VALID_POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.name).toBe("Balanced Allocation");
      expect(result.policy.rules).toHaveLength(2);
    }
  });

  it("rejects null input", () => {
    const result = validatePolicy(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects empty name", () => {
    const result = validatePolicy({ ...VALID_POLICY, name: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "name")).toBe(true);
    }
  });

  it("rejects missing version", () => {
    const result = validatePolicy({ ...VALID_POLICY, version: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "version")).toBe(true);
    }
  });

  it("rejects empty rules array", () => {
    const result = validatePolicy({ ...VALID_POLICY, rules: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "rules")).toBe(true);
    }
  });

  it("rejects rules with invalid weight", () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      rules: [
        {
          id: "bad-weight",
          weight: 1.5,
          conditions: {},
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes("weight"))).toBe(true);
    }
  });

  it("rejects rules with negative weight", () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      rules: [
        {
          id: "neg-weight",
          weight: -0.1,
          conditions: {},
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects weights not summing to 1.0", () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      rules: [
        { id: "r1", weight: 0.3, conditions: {} },
        { id: "r2", weight: 0.3, conditions: {} },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "WEIGHT_SUM")).toBe(true);
    }
  });

  it("rejects duplicate rule ids", () => {
    const result = validatePolicy({
      name: "Duplicate",
      version: "1.0",
      rules: [
        { id: "same-id", weight: 0.5, conditions: {} },
        { id: "same-id", weight: 0.5, conditions: {} },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "DUPLICATE_ID")).toBe(true);
    }
  });

  it("rejects reserved rule ids", () => {
    const result = validatePolicy({
      name: "Reserved",
      version: "1.0",
      rules: [
        { id: "__default__", weight: 1.0, conditions: {} },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "RESERVED_ID")).toBe(true);
    }
  });

  it("rejects allowlist that is not an array of strings", () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      rules: [
        {
          id: "bad-allowlist",
          weight: 1.0,
          conditions: { allowlist: [123] },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects deny-list that is not an array of strings", () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      rules: [
        {
          id: "bad-denylist",
          weight: 1.0,
          conditions: { denylist: [true] },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid maxVolatility", () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      rules: [
        {
          id: "bad-vol",
          weight: 1.0,
          conditions: { maxVolatility: 150 },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid cooldown duration", () => {
    const result = validatePolicy({
      ...VALID_POLICY,
      rules: [
        {
          id: "bad-cd",
          weight: 1.0,
          conditions: {},
          cooldown: { durationMs: -1 },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts policy with only allowlist conditions", () => {
    const result = validatePolicy({
      name: "Allowlist Only",
      version: "1.0",
      rules: [
        {
          id: "blend-only",
          weight: 1.0,
          conditions: { allowlist: ["Blend"] },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts policy with denylist conditions", () => {
    const result = validatePolicy({
      name: "Denylist",
      version: "1.0",
      rules: [
        {
          id: "no-defindex",
          weight: 1.0,
          conditions: { denylist: ["DeFindex"] },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("storePolicy and getPolicy", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("stores and retrieves a policy", () => {
    const validation = validatePolicy(VALID_POLICY);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    storePolicy(validation.policy);
    const retrieved = getPolicy(validation.policy.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("Balanced Allocation");
  });

  it("returns undefined for non-existent policy", () => {
    expect(getPolicy("non-existent")).toBeUndefined();
  });
});

describe("listPolicies", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("returns all stored policies", () => {
    const p1 = validatePolicy({ ...VALID_POLICY, name: "Policy 1" });
    const p2 = validatePolicy({ ...VALID_POLICY, name: "Policy 2" });
    if (!p1.ok || !p2.ok) return;

    storePolicy(p1.policy);
    storePolicy(p2.policy);

    const all = listPolicies();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.name)).toEqual(expect.arrayContaining(["Policy 1", "Policy 2"]));
  });

  it("returns empty array when no policies stored", () => {
    expect(listPolicies()).toEqual([]);
  });
});

describe("deletePolicy", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("deletes an existing policy", () => {
    const validation = validatePolicy(VALID_POLICY);
    if (!validation.ok) return;

    storePolicy(validation.policy);
    expect(deletePolicy(validation.policy.id)).toBe(true);
    expect(getPolicy(validation.policy.id)).toBeUndefined();
  });

  it("returns false for non-existent policy", () => {
    expect(deletePolicy("ghost")).toBe(false);
  });
});

describe("updatePolicy", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("updates an existing policy", () => {
    const validation = validatePolicy(VALID_POLICY);
    if (!validation.ok) return;

    storePolicy(validation.policy);

    const updateResult = updatePolicy(validation.policy.id, {
      ...VALID_POLICY,
      name: "Updated Policy",
      version: "2.0.0",
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;

    const updated = getPolicy(validation.policy.id);
    expect(updated!.name).toBe("Updated Policy");
    expect(updated!.version).toBe("2.0.0");
    expect(updated!.id).toBe(validation.policy.id);
    expect(updated!.createdAt).toBe(validation.policy.createdAt);
  });

  it("returns error for non-existent policy", () => {
    const result = updatePolicy("ghost", VALID_POLICY);
    expect(result.ok).toBe(false);
  });
});

describe("evaluatePolicy", () => {
  let policy: AllocationPolicy;

  beforeEach(() => {
    resetPolicyStore();
    const validation = validatePolicy(VALID_POLICY);
    if (!validation.ok) throw new Error("Invalid test policy");
    policy = validation.policy;
    storePolicy(policy);
  });

  it("matches the first rule when conditions are satisfied", () => {
    const ctx: PolicyEvaluationContext = {
      vaultId: "Blend",
      tvlUsd: 5_000_000,
      apyPct: 10,
      volatilityPct: 8,
      currentAllocationPct: 30,
    };

    const result = evaluatePolicy(policy, ctx);
    expect(result.matched).toBe(true);
    expect(result.ruleId).toBe("high-yield-stable");
    expect(result.effectiveWeight).toBe(0.6);
  });

  it("matches second rule when first rule conditions fail", () => {
    const ctx: PolicyEvaluationContext = {
      vaultId: "Soroswap",
      tvlUsd: 600_000,
      apyPct: 12,
      volatilityPct: 25,
      currentAllocationPct: 20,
    };

    const result = evaluatePolicy(policy, ctx);
    expect(result.matched).toBe(true);
    expect(result.ruleId).toBe("growth-focused");
    expect(result.effectiveWeight).toBe(0.4);
  });

  it("uses default rule when no rules match", () => {
    const ctx: PolicyEvaluationContext = {
      vaultId: "Unknown",
      tvlUsd: 100_000,
      apyPct: 3,
      volatilityPct: 60,
      currentAllocationPct: 5,
    };

    const result = evaluatePolicy(policy, ctx);
    expect(result.matched).toBe(true);
    expect(result.ruleId).toBeNull();
    expect(result.effectiveWeight).toBe(0.5);
  });

  it("blocks vaults in denylist", () => {
    const denylistPolicy = validatePolicy({
      name: "Denylist Test",
      version: "1.0",
      rules: [
        {
          id: "no-defindex",
          weight: 1.0,
          conditions: { denylist: ["DeFindex"] },
        },
      ],
    });
    if (!denylistPolicy.ok) return;

    const ctx: PolicyEvaluationContext = {
      vaultId: "DeFindex",
      tvlUsd: 1_000_000,
      apyPct: 10,
      volatilityPct: 10,
      currentAllocationPct: 10,
    };

    const result = evaluatePolicy(denylistPolicy.policy, ctx);
    expect(result.matched).toBe(false);
    expect(result.blocked.length).toBeGreaterThan(0);
    expect(result.blocked[0]).toContain("denylist");
  });

  it("respects allowlist filtering", () => {
    const allowlistPolicy = validatePolicy({
      name: "Allowlist Test",
      version: "1.0",
      rules: [
        {
          id: "blend-only",
          weight: 1.0,
          conditions: { allowlist: ["Blend"] },
        },
      ],
    });
    if (!allowlistPolicy.ok) return;

    const ctx: PolicyEvaluationContext = {
      vaultId: "Soroswap",
      tvlUsd: 1_000_000,
      apyPct: 10,
      volatilityPct: 10,
      currentAllocationPct: 10,
    };

    const result = evaluatePolicy(allowlistPolicy.policy, ctx);
    expect(result.matched).toBe(false);
    expect(result.blocked[0]).toContain("allowlist");
  });

  it("enforces cooldown periods", () => {
    const validation = validatePolicy(VALID_POLICY);
    if (!validation.ok) return;

    storePolicy(validation.policy);
    markRuleExecuted(validation.policy.id, "high-yield-stable");

    const ctx: PolicyEvaluationContext = {
      vaultId: "Blend",
      tvlUsd: 5_000_000,
      apyPct: 10,
      volatilityPct: 8,
      currentAllocationPct: 30,
    };

    const result = evaluatePolicy(validation.policy, ctx);
    expect(result.cooldownActive).toBe(true);
    expect(result.ruleId).not.toBe("high-yield-stable");
  });

  it("enforces threshold constraints", () => {
    const ctx: PolicyEvaluationContext = {
      vaultId: "Blend",
      tvlUsd: 5_000_000,
      apyPct: 10,
      volatilityPct: 8,
      currentAllocationPct: 80,
    };

    const result = evaluatePolicy(policy, ctx);
    expect(result.ruleId).not.toBe("high-yield-stable");
    expect(result.reasons.some((r) => r.includes("threshold"))).toBe(true);
  });

  it("skips rule when TVL is below minTvl", () => {
    const ctx: PolicyEvaluationContext = {
      vaultId: "Blend",
      tvlUsd: 100_000,
      apyPct: 10,
      volatilityPct: 8,
      currentAllocationPct: 30,
    };

    const result = evaluatePolicy(policy, ctx);
    expect(result.ruleId).not.toBe("high-yield-stable");
    expect(result.reasons.some((r) => r.includes("minTvl"))).toBe(true);
  });
});

describe("markRuleExecuted", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("sets cooldown timestamp on a rule", () => {
    const validation = validatePolicy(VALID_POLICY);
    if (!validation.ok) return;

    storePolicy(validation.policy);
    const success = markRuleExecuted(validation.policy.id, "high-yield-stable");
    expect(success).toBe(true);

    const policy = getPolicy(validation.policy.id);
    const rule = policy!.rules.find((r) => r.id === "high-yield-stable");
    expect(rule!.cooldown!.lastExecuted).toBeDefined();
  });

  it("returns false for non-existent policy", () => {
    expect(markRuleExecuted("ghost", "rule-id")).toBe(false);
  });

  it("returns false for rule without cooldown config", () => {
    const validation = validatePolicy({
      ...VALID_POLICY,
      rules: [
        {
          id: "no-cooldown",
          weight: 1.0,
          conditions: {},
        },
      ],
    });
    if (!validation.ok) return;

    storePolicy(validation.policy);
    expect(markRuleExecuted(validation.policy.id, "no-cooldown")).toBe(false);
  });
});

describe("Policy lifecycle integration", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("full create → store → evaluate → update lifecycle", () => {
    const v1 = validatePolicy(VALID_POLICY);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    storePolicy(v1.policy);
    expect(listPolicies()).toHaveLength(1);

    const ctx: PolicyEvaluationContext = {
      vaultId: "Blend",
      tvlUsd: 5_000_000,
      apyPct: 10,
      volatilityPct: 8,
      currentAllocationPct: 30,
    };
    const evalResult = evaluatePolicy(v1.policy, ctx);
    expect(evalResult.matched).toBe(true);
    expect(evalResult.ruleId).toBe("high-yield-stable");

    const updated = updatePolicy(v1.policy.id, {
      ...VALID_POLICY,
      name: "Updated Strategy",
      version: "2.0.0",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.policy.name).toBe("Updated Strategy");

    expect(deletePolicy(v1.policy.id)).toBe(true);
    expect(listPolicies()).toHaveLength(0);
  });
});
