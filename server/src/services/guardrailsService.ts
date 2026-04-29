export interface GuardrailRule {
  id: string
  name: string
  type: 'max-concentration' | 'max-slippage' | 'min-liquidity' | 'pause-condition'
  enabled: boolean
  threshold: number
  priority: number // Higher = more important
  description: string
}

export interface GuardrailContext {
  concentration?: number
  slippage?: number
  liquidity?: number
  isMarketPaused?: boolean
  strategyId: string
}

export interface GuardrailEvaluationResult {
  passed: boolean
  blockedRules: GuardrailRule[]
  warnings: string[]
  failureReason?: string
}

const DEFAULT_RULES: GuardrailRule[] = [
  {
    id: 'max-concentration-50',
    name: 'Max Concentration 50%',
    type: 'max-concentration',
    enabled: true,
    threshold: 50,
    priority: 10,
    description: 'Prevent single position exceeding 50% of portfolio',
  },
  {
    id: 'max-slippage-2',
    name: 'Max Slippage 2%',
    type: 'max-slippage',
    enabled: true,
    threshold: 2,
    priority: 8,
    description: 'Limit slippage on trades to 2%',
  },
  {
    id: 'min-liquidity-100k',
    name: 'Min Liquidity 100k',
    type: 'min-liquidity',
    enabled: true,
    threshold: 100000,
    priority: 7,
    description: 'Require minimum pool liquidity of $100k',
  },
  {
    id: 'pause-on-market-pause',
    name: 'Pause on Market Pause',
    type: 'pause-condition',
    enabled: true,
    threshold: 0,
    priority: 100,
    description: 'Halt operations if market is paused',
  },
]

export class GuardrailsService {
  private rules: Map<string, GuardrailRule> = new Map()
  private strategyRuleMap: Map<string, Set<string>> = new Map() // strategy -> rule IDs

  constructor(initialRules: GuardrailRule[] = DEFAULT_RULES) {
    for (const rule of initialRules) {
      this.rules.set(rule.id, rule)
    }
  }

  evaluateGuardrails(context: GuardrailContext): GuardrailEvaluationResult {
    if (!context.strategyId) {
      return {
        passed: false,
        blockedRules: [],
        warnings: ['Missing strategy ID in context'],
        failureReason: 'Invalid context: missing strategyId',
      }
    }

    const applicableRules = this.getApplicableRules(context.strategyId)
    const blockedRules: GuardrailRule[] = []
    const warnings: string[] = []

    // Sort rules by priority (higher first)
    const sortedRules = [...applicableRules].sort((a, b) => b.priority - a.priority)

    for (const rule of sortedRules) {
      if (!rule.enabled) continue

      const passed = this.evaluateRule(rule, context)
      if (!passed) {
        blockedRules.push(rule)
        warnings.push(`Guardrail blocked: ${rule.name}`)

        // Fail-closed: stop evaluating if critical rule fails
        if (rule.priority > 50) {
          break
        }
      }
    }

    return {
      passed: blockedRules.length === 0,
      blockedRules,
      warnings,
      failureReason: blockedRules.length > 0 ? blockedRules[0].name : undefined,
    }
  }

  private evaluateRule(rule: GuardrailRule, context: GuardrailContext): boolean {
    switch (rule.type) {
      case 'max-concentration':
        return (context.concentration ?? 0) <= rule.threshold

      case 'max-slippage':
        return (context.slippage ?? 0) <= rule.threshold

      case 'min-liquidity':
        return (context.liquidity ?? 0) >= rule.threshold

      case 'pause-condition':
        return !(context.isMarketPaused ?? false)

      default:
        return true
    }
  }

  addRule(rule: GuardrailRule): void {
    this.rules.set(rule.id, rule)
  }

  removeRule(ruleId: string): boolean {
    if (this.rules.has(ruleId)) {
      this.rules.delete(ruleId)
      // Remove from all strategy associations
      for (const strategyRules of this.strategyRuleMap.values()) {
        strategyRules.delete(ruleId)
      }
      return true
    }
    return false
  }

  updateRule(ruleId: string, updates: Partial<GuardrailRule>): boolean {
    const rule = this.rules.get(ruleId)
    if (!rule) return false

    Object.assign(rule, updates, { id: rule.id }) // Preserve ID
    return true
  }

  enableRule(ruleId: string): boolean {
    const rule = this.rules.get(ruleId)
    if (rule) {
      rule.enabled = true
      return true
    }
    return false
  }

  disableRule(ruleId: string): boolean {
    const rule = this.rules.get(ruleId)
    if (rule) {
      rule.enabled = false
      return true
    }
    return false
  }

  associateRuleWithStrategy(strategyId: string, ruleId: string): boolean {
    if (!this.rules.has(ruleId)) return false

    if (!this.strategyRuleMap.has(strategyId)) {
      this.strategyRuleMap.set(strategyId, new Set())
    }

    this.strategyRuleMap.get(strategyId)!.add(ruleId)
    return true
  }

  removeRuleFromStrategy(strategyId: string, ruleId: string): boolean {
    const rules = this.strategyRuleMap.get(strategyId)
    if (rules) {
      return rules.delete(ruleId)
    }
    return false
  }

  private getApplicableRules(strategyId: string): GuardrailRule[] {
    const strategyRuleIds = this.strategyRuleMap.get(strategyId)

    if (strategyRuleIds && strategyRuleIds.size > 0) {
      // Strategy-specific rules
      return Array.from(strategyRuleIds)
        .map(id => this.rules.get(id))
        .filter((rule): rule is GuardrailRule => rule !== undefined)
    }

    // Default to all enabled global rules
    return Array.from(this.rules.values()).filter(rule => rule.enabled)
  }

  getAllRules(): GuardrailRule[] {
    return Array.from(this.rules.values())
  }

  getStrategyRules(strategyId: string): GuardrailRule[] {
    return this.getApplicableRules(strategyId)
  }
}

export function createGuardrailsService(rules?: GuardrailRule[]) {
  return new GuardrailsService(rules)
}
