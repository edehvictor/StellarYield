import { GuardrailsService, type GuardrailRule } from '../services/guardrailsService'

describe('GuardrailsService', () => {
  let service: GuardrailsService

  beforeEach(() => {
    service = new GuardrailsService()
  })

  describe('evaluateGuardrails', () => {
    it('should pass all guardrails when conditions are met', () => {
      const result = service.evaluateGuardrails({
        strategyId: 'strategy-1',
        concentration: 30,
        slippage: 1,
        liquidity: 500000,
        isMarketPaused: false,
      })

      expect(result.passed).toBe(true)
      expect(result.blockedRules).toEqual([])
    })

    it('should block max concentration guardrail', () => {
      const result = service.evaluateGuardrails({
        strategyId: 'strategy-1',
        concentration: 75,
        slippage: 1,
        liquidity: 500000,
        isMarketPaused: false,
      })

      expect(result.passed).toBe(false)
      expect(result.blockedRules.length).toBeGreaterThan(0)
      expect(result.blockedRules.some(r => r.type === 'max-concentration')).toBe(true)
    })

    it('should block max slippage guardrail', () => {
      const result = service.evaluateGuardrails({
        strategyId: 'strategy-1',
        concentration: 30,
        slippage: 5,
        liquidity: 500000,
        isMarketPaused: false,
      })

      expect(result.passed).toBe(false)
      expect(result.blockedRules.some(r => r.type === 'max-slippage')).toBe(true)
    })

    it('should block min liquidity guardrail', () => {
      const result = service.evaluateGuardrails({
        strategyId: 'strategy-1',
        concentration: 30,
        slippage: 1,
        liquidity: 50000,
        isMarketPaused: false,
      })

      expect(result.passed).toBe(false)
      expect(result.blockedRules.some(r => r.type === 'min-liquidity')).toBe(true)
    })

    it('should block pause condition guardrail', () => {
      const result = service.evaluateGuardrails({
        strategyId: 'strategy-1',
        concentration: 30,
        slippage: 1,
        liquidity: 500000,
        isMarketPaused: true,
      })

      expect(result.passed).toBe(false)
      expect(result.blockedRules.some(r => r.type === 'pause-condition')).toBe(true)
    })

    it('should fail-closed on critical rule failure', () => {
      const result = service.evaluateGuardrails({
        strategyId: 'strategy-1',
        concentration: 30,
        slippage: 1,
        liquidity: 500000,
        isMarketPaused: true, // Critical rule failure
      })

      expect(result.passed).toBe(false)
      expect(result.failureReason).toBeDefined()
    })

    it('should reject context without strategyId', () => {
      const result = service.evaluateGuardrails({
        strategyId: '',
        concentration: 30,
      })

      expect(result.passed).toBe(false)
      expect(result.failureReason).toContain('Invalid context')
    })
  })

  describe('rule management', () => {
    it('should add a new rule', () => {
      const newRule: GuardrailRule = {
        id: 'custom-rule',
        name: 'Custom Rule',
        type: 'max-concentration',
        enabled: true,
        threshold: 30,
        priority: 5,
        description: 'Custom guardrail',
      }

      service.addRule(newRule)
      const rules = service.getAllRules()

      expect(rules.some(r => r.id === 'custom-rule')).toBe(true)
    })

    it('should remove a rule', () => {
      const removed = service.removeRule('max-concentration-50')

      expect(removed).toBe(true)
      const rules = service.getAllRules()
      expect(rules.some(r => r.id === 'max-concentration-50')).toBe(false)
    })

    it('should update a rule', () => {
      const updated = service.updateRule('max-concentration-50', {
        threshold: 60,
        name: 'Updated Max Concentration',
      })

      expect(updated).toBe(true)
      const rules = service.getAllRules()
      const rule = rules.find(r => r.id === 'max-concentration-50')
      expect(rule?.threshold).toBe(60)
      expect(rule?.name).toBe('Updated Max Concentration')
    })

    it('should enable/disable rules', () => {
      service.disableRule('max-concentration-50')
      let rules = service.getAllRules()
      let rule = rules.find(r => r.id === 'max-concentration-50')
      expect(rule?.enabled).toBe(false)

      service.enableRule('max-concentration-50')
      rules = service.getAllRules()
      rule = rules.find(r => r.id === 'max-concentration-50')
      expect(rule?.enabled).toBe(true)
    })
  })

  describe('strategy-specific rules', () => {
    it('should associate rules with strategies', () => {
      const associated = service.associateRuleWithStrategy('strategy-1', 'max-concentration-50')

      expect(associated).toBe(true)
      const strategyRules = service.getStrategyRules('strategy-1')
      expect(strategyRules.some(r => r.id === 'max-concentration-50')).toBe(true)
    })

    it('should fail to associate non-existent rule', () => {
      const associated = service.associateRuleWithStrategy('strategy-1', 'non-existent-rule')

      expect(associated).toBe(false)
    })

    it('should remove rule from strategy', () => {
      service.associateRuleWithStrategy('strategy-1', 'max-concentration-50')
      const removed = service.removeRuleFromStrategy('strategy-1', 'max-concentration-50')

      expect(removed).toBe(true)
    })

    it('should use strategy-specific rules if associated', () => {
      // Create a minimal custom rule set for this strategy
      const customRule: GuardrailRule = {
        id: 'strict-concentration',
        name: 'Strict Concentration 20%',
        type: 'max-concentration',
        enabled: true,
        threshold: 20,
        priority: 10,
        description: 'Strict concentration limit for this strategy',
      }

      service.addRule(customRule)
      service.associateRuleWithStrategy('strategy-2', 'strict-concentration')

      const result = service.evaluateGuardrails({
        strategyId: 'strategy-2',
        concentration: 25,
        slippage: 1,
        liquidity: 500000,
        isMarketPaused: false,
      })

      // Should use the strategy-specific rule
      expect(result.passed).toBe(false)
    })
  })
})
