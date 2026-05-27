export interface AllocationRuleCondition {
  allowlist?: string[];
  denylist?: string[];
  minTvl?: number;
  maxTvl?: number;
  minApy?: number;
  maxApy?: number;
  maxVolatility?: number;
}

export interface AllocationRuleCooldown {
  durationMs: number;
  lastExecuted?: string;
}

export interface AllocationRuleThreshold {
  min?: number;
  max?: number;
}

export interface AllocationRule {
  id: string;
  description?: string;
  weight: number;
  conditions: AllocationRuleCondition;
  cooldown?: AllocationRuleCooldown;
  threshold?: AllocationRuleThreshold;
}

export interface AllocationPolicy {
  id: string;
  name: string;
  description?: string;
  version: string;
  rules: AllocationRule[];
  defaultRule?: AllocationRule;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyEvaluationContext {
  vaultId: string;
  tvlUsd: number;
  apyPct: number;
  volatilityPct: number;
  currentAllocationPct: number;
}

export interface PolicyEvaluationResult {
  matched: boolean;
  ruleId: string | null;
  effectiveWeight: number;
  reasons: string[];
  blocked: string[];
  cooldownActive: boolean;
}

export interface PolicyValidationError {
  path: string;
  message: string;
  code: string;
}

export type PolicyValidationResult =
  | { ok: true; policy: AllocationPolicy }
  | { ok: false; errors: PolicyValidationError[] };

const RESERVED_RULE_IDS = ["__default__", "__fallback__"];

const policyStore = new Map<string, AllocationPolicy>();

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function validatePolicy(raw: unknown): PolicyValidationResult {
  const errors: PolicyValidationError[] = [];

  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      errors: [{ path: "", message: "Policy must be a non-null object", code: "INVALID_TYPE" }],
    };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    errors.push({ path: "name", message: "name is required and must be a non-empty string", code: "REQUIRED" });
  }

  if (typeof obj.version !== "string" || obj.version.trim().length === 0) {
    errors.push({ path: "version", message: "version is required and must be a non-empty string", code: "REQUIRED" });
  }

  if (typeof obj.description !== "undefined" && typeof obj.description !== "string") {
    errors.push({ path: "description", message: "description must be a string", code: "INVALID_TYPE" });
  }

  if (!Array.isArray(obj.rules)) {
    errors.push({ path: "rules", message: "rules must be a non-empty array", code: "REQUIRED" });
    return { ok: false, errors };
  }

  if (obj.rules.length === 0) {
    errors.push({ path: "rules", message: "rules must contain at least one rule", code: "MIN_LENGTH" });
  }

  const seenIds = new Set<string>();
  (obj.rules as unknown[]).forEach((rule, index) => {
    const ruleObj = rule as Record<string, unknown>;
    const prefix = `rules[${index}]`;

    if (!ruleObj || typeof ruleObj !== "object") {
      errors.push({ path: prefix, message: "Each rule must be a non-null object", code: "INVALID_TYPE" });
      return;
    }

    if (typeof ruleObj.id !== "string" || ruleObj.id.trim().length === 0) {
      errors.push({ path: `${prefix}.id`, message: "rule.id is required and must be a non-empty string", code: "REQUIRED" });
    } else {
      if (RESERVED_RULE_IDS.includes(ruleObj.id as string)) {
        errors.push({ path: `${prefix}.id`, message: `rule.id "${ruleObj.id}" is reserved`, code: "RESERVED_ID" });
      }
      if (seenIds.has(ruleObj.id as string)) {
        errors.push({ path: `${prefix}.id`, message: `Duplicate rule id "${ruleObj.id}"`, code: "DUPLICATE_ID" });
      }
      seenIds.add(ruleObj.id as string);
    }

    if (typeof ruleObj.weight !== "number" || ruleObj.weight < 0 || ruleObj.weight > 1) {
      errors.push({ path: `${prefix}.weight`, message: "rule.weight must be a number between 0 and 1", code: "INVALID_RANGE" });
    }

    if (typeof ruleObj.conditions !== "object" || ruleObj.conditions === null) {
      errors.push({ path: `${prefix}.conditions`, message: "rule.conditions must be an object", code: "REQUIRED" });
    } else {
      const cond = ruleObj.conditions as Record<string, unknown>;

      if (cond.allowlist !== undefined) {
        if (!Array.isArray(cond.allowlist) || !(cond.allowlist as unknown[]).every((v) => typeof v === "string")) {
          errors.push({ path: `${prefix}.conditions.allowlist`, message: "allowlist must be an array of strings", code: "INVALID_TYPE" });
        }
      }

      if (cond.denylist !== undefined) {
        if (!Array.isArray(cond.denylist) || !(cond.denylist as unknown[]).every((v) => typeof v === "string")) {
          errors.push({ path: `${prefix}.conditions.denylist`, message: "denylist must be an array of strings", code: "INVALID_TYPE" });
        }
      }

      if (cond.minTvl !== undefined && (typeof cond.minTvl !== "number" || cond.minTvl < 0)) {
        errors.push({ path: `${prefix}.conditions.minTvl`, message: "minTvl must be a non-negative number", code: "INVALID_RANGE" });
      }

      if (cond.maxTvl !== undefined && (typeof cond.maxTvl !== "number" || cond.maxTvl < 0)) {
        errors.push({ path: `${prefix}.conditions.maxTvl`, message: "maxTvl must be a non-negative number", code: "INVALID_RANGE" });
      }

      if (cond.maxVolatility !== undefined && (typeof cond.maxVolatility !== "number" || cond.maxVolatility < 0 || cond.maxVolatility > 100)) {
        errors.push({ path: `${prefix}.conditions.maxVolatility`, message: "maxVolatility must be a number between 0 and 100", code: "INVALID_RANGE" });
      }

      if (cond.minApy !== undefined && typeof cond.minApy !== "number") {
        errors.push({ path: `${prefix}.conditions.minApy`, message: "minApy must be a number", code: "INVALID_TYPE" });
      }

      if (cond.maxApy !== undefined && typeof cond.maxApy !== "number") {
        errors.push({ path: `${prefix}.conditions.maxApy`, message: "maxApy must be a number", code: "INVALID_TYPE" });
      }
    }

    if (ruleObj.cooldown !== undefined) {
      if (typeof ruleObj.cooldown !== "object" || ruleObj.cooldown === null) {
        errors.push({ path: `${prefix}.cooldown`, message: "cooldown must be an object", code: "INVALID_TYPE" });
      } else {
        const cd = ruleObj.cooldown as Record<string, unknown>;
        if (typeof cd.durationMs !== "number" || cd.durationMs < 0) {
          errors.push({ path: `${prefix}.cooldown.durationMs`, message: "cooldown.durationMs must be a non-negative number", code: "INVALID_RANGE" });
        }
      }
    }

    if (ruleObj.threshold !== undefined) {
      if (typeof ruleObj.threshold !== "object" || ruleObj.threshold === null) {
        errors.push({ path: `${prefix}.threshold`, message: "threshold must be an object", code: "INVALID_TYPE" });
      } else {
        const th = ruleObj.threshold as Record<string, unknown>;
        if (th.min !== undefined && typeof th.min !== "number") {
          errors.push({ path: `${prefix}.threshold.min`, message: "threshold.min must be a number", code: "INVALID_TYPE" });
        }
        if (th.max !== undefined && typeof th.max !== "number") {
          errors.push({ path: `${prefix}.threshold.max`, message: "threshold.max must be a number", code: "INVALID_TYPE" });
        }
      }
    }
  });

  const totalWeight = (obj.rules as unknown[]).reduce<number>((sum, rule) => {
    const r = rule as Record<string, unknown>;
    return sum + (typeof r.weight === "number" ? r.weight : 0);
  }, 0);

  if (totalWeight > 0 && Math.abs(totalWeight - 1) > 0.001) {
    errors.push({
      path: "rules",
      message: `Total weight of all rules must sum to 1.0 (got ${totalWeight.toFixed(3)})`,
      code: "WEIGHT_SUM",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const now = new Date().toISOString();
  const policy: AllocationPolicy = {
    id: (obj.id as string) || generateId(),
    name: (obj.name as string).trim(),
    description: (obj.description as string)?.trim(),
    version: (obj.version as string).trim(),
    rules: (obj.rules as unknown[]).map((rule) => {
      const r = rule as Record<string, unknown>;
      const conditions = r.conditions as AllocationRuleCondition;
      return {
        id: r.id as string,
        description: r.description as string | undefined,
        weight: r.weight as number,
        conditions,
        cooldown: r.cooldown ? {
          durationMs: (r.cooldown as Record<string, unknown>).durationMs as number,
          lastExecuted: (r.cooldown as Record<string, unknown>).lastExecuted as string | undefined,
        } : undefined,
        threshold: r.threshold ? {
          min: (r.threshold as Record<string, unknown>).min as number | undefined,
          max: (r.threshold as Record<string, unknown>).max as number | undefined,
        } : undefined,
      };
    }),
    defaultRule: obj.defaultRule
      ? ({
          id: "__default__",
          weight: 0.5,
          conditions: (obj.defaultRule as Record<string, unknown>).conditions as AllocationRuleCondition || {},
        } as AllocationRule)
      : undefined,
    createdAt: now,
    updatedAt: now,
  };

  return { ok: true, policy };
}

export function storePolicy(policy: AllocationPolicy): void {
  policyStore.set(policy.id, policy);
}

export function getPolicy(id: string): AllocationPolicy | undefined {
  return policyStore.get(id);
}

export function listPolicies(): AllocationPolicy[] {
  return Array.from(policyStore.values());
}

export function deletePolicy(id: string): boolean {
  return policyStore.delete(id);
}

export function updatePolicy(id: string, raw: unknown): PolicyValidationResult {
  const existing = policyStore.get(id);
  if (!existing) {
    return { ok: false, errors: [{ path: "id", message: `Policy "${id}" not found`, code: "NOT_FOUND" }] };
  }

  const validation = validatePolicy(raw);
  if (!validation.ok) {
    return validation;
  }

  const policy: AllocationPolicy = {
    ...validation.policy,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  policyStore.set(id, policy);
  return { ok: true, policy };
}

export function resetPolicyStore(): void {
  policyStore.clear();
}

function isOnCooldown(rule: AllocationRule): boolean {
  if (!rule.cooldown || !rule.cooldown.lastExecuted) return false;
  const elapsed = Date.now() - new Date(rule.cooldown.lastExecuted).getTime();
  return elapsed < rule.cooldown.durationMs;
}

export function evaluatePolicy(
  policy: AllocationPolicy,
  ctx: PolicyEvaluationContext,
): PolicyEvaluationResult {
  const reasons: string[] = [];
  const blocked: string[] = [];
  let matched = false;
  let matchedRuleId: string | null = null;
  let effectiveWeight = policy.defaultRule?.weight ?? 0.5;
  let cooldownActive = false;

  for (const rule of policy.rules) {
    const cond = rule.conditions;

    if (cond.allowlist && cond.allowlist.length > 0) {
      if (!cond.allowlist.includes(ctx.vaultId)) {
        blocked.push(`Vault "${ctx.vaultId}" not in allowlist for rule "${rule.id}"`);
        continue;
      }
    }

    if (cond.denylist && cond.denylist.length > 0) {
      if (cond.denylist.includes(ctx.vaultId)) {
        blocked.push(`Vault "${ctx.vaultId}" in denylist for rule "${rule.id}"`);
        continue;
      }
    }

    if (cond.minTvl !== undefined && ctx.tvlUsd < cond.minTvl) {
      reasons.push(`TVL ${ctx.tvlUsd} below minTvl ${cond.minTvl} for rule "${rule.id}"`);
      continue;
    }

    if (cond.maxTvl !== undefined && ctx.tvlUsd > cond.maxTvl) {
      reasons.push(`TVL ${ctx.tvlUsd} above maxTvl ${cond.maxTvl} for rule "${rule.id}"`);
      continue;
    }

    if (cond.minApy !== undefined && ctx.apyPct < cond.minApy) {
      reasons.push(`APY ${ctx.apyPct}% below minApy ${cond.minApy}% for rule "${rule.id}"`);
      continue;
    }

    if (cond.maxApy !== undefined && ctx.apyPct > cond.maxApy) {
      reasons.push(`APY ${ctx.apyPct}% above maxApy ${cond.maxApy}% for rule "${rule.id}"`);
      continue;
    }

    if (cond.maxVolatility !== undefined && ctx.volatilityPct > cond.maxVolatility) {
      reasons.push(`Volatility ${ctx.volatilityPct}% above maxVolatility ${cond.maxVolatility}% for rule "${rule.id}"`);
      continue;
    }

    if (rule.threshold) {
      if (rule.threshold.min !== undefined && ctx.currentAllocationPct < rule.threshold.min) {
        reasons.push(`Allocation ${ctx.currentAllocationPct}% below threshold min ${rule.threshold.min}% for rule "${rule.id}"`);
        continue;
      }
      if (rule.threshold.max !== undefined && ctx.currentAllocationPct > rule.threshold.max) {
        reasons.push(`Allocation ${ctx.currentAllocationPct}% above threshold max ${rule.threshold.max}% for rule "${rule.id}"`);
        continue;
      }
    }

    if (isOnCooldown(rule)) {
      cooldownActive = true;
      reasons.push(`Rule "${rule.id}" is on cooldown until ${rule.cooldown!.lastExecuted}`);
      continue;
    }

    matched = true;
    matchedRuleId = rule.id;
    effectiveWeight = rule.weight;
    reasons.push(`Matched rule "${rule.id}" with weight ${rule.weight}`);
    break;
  }

  if (!matched && policy.defaultRule) {
    matched = true;
    reasons.push(`No rule matched, using default rule with weight ${policy.defaultRule.weight}`);
  }

  return { matched, ruleId: matchedRuleId, effectiveWeight, reasons, blocked, cooldownActive };
}

export function markRuleExecuted(policyId: string, ruleId: string): boolean {
  const policy = policyStore.get(policyId);
  if (!policy) return false;

  const rule = policy.rules.find((r) => r.id === ruleId);
  if (!rule || !rule.cooldown) return false;

  rule.cooldown.lastExecuted = new Date().toISOString();
  policy.updatedAt = new Date().toISOString();
  policyStore.set(policyId, policy);
  return true;
}
