import { StressMatrixService, type StressScenario } from '../services/stressMatrixService';

describe('StressMatrixService', () => {
  describe('scenario generation', () => {
    it('should generate default scenarios', () => {
      const service = new StressMatrixService();
      const scenarios = service.getScenarios();

      expect(scenarios.length).toBeGreaterThan(0);
      expect(scenarios.some(s => s.id === 'multi-factor-meltdown')).toBe(true);
      expect(scenarios.some(s => s.id === 'liquidity-crisis')).toBe(true);
      expect(scenarios.some(s => s.id === 'oracle-manipulation')).toBe(true);
      expect(scenarios.some(s => s.id === 'trust-collapse')).toBe(true);
      expect(scenarios.some(s => s.id === 'confidence-crisis')).toBe(true);
      expect(scenarios.some(s => s.id === 'mild-downturn')).toBe(true);
    });

    it('should add custom scenarios', () => {
      const service = new StressMatrixService();
      const customScenario: StressScenario = {
        id: 'custom-flash-crash',
        name: 'Custom Flash Crash',
        description: 'Rapid market crash scenario',
        factors: { liquidity: 80, trust: 60, confidence: 70, oracle: 40 },
      };

      service.addScenario(customScenario);
      const scenarios = service.getScenarios();
      expect(scenarios.some(s => s.id === 'custom-flash-crash')).toBe(true);
    });

    it('should remove scenarios', () => {
      const service = new StressMatrixService();
      const removed = service.removeScenario('mild-downturn');
      expect(removed).toBe(true);
      expect(service.getScenarios().some(s => s.id === 'mild-downturn')).toBe(false);
    });

    it('should return false when removing non-existent scenario', () => {
      const service = new StressMatrixService();
      const removed = service.removeScenario('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('guardrail activation correctness', () => {
    it('should have no activations under mild downturn', () => {
      const service = new StressMatrixService();
      const result = service.runMatrix();
      const mild = result.scenarios.find(s => s.scenarioId === 'mild-downturn');

      expect(mild).toBeDefined();
      expect(mild!.guardrailActivations.length).toBe(0);
      expect(mild!.summary.status).toBe('all-passed');
    });

    it('should activate guardrails under multi-factor meltdown', () => {
      const service = new StressMatrixService();
      const result = service.runMatrix();
      const meltdown = result.scenarios.find(s => s.scenarioId === 'multi-factor-meltdown');

      expect(meltdown).toBeDefined();
      expect(meltdown!.guardrailActivations.length).toBeGreaterThan(0);
      expect(meltdown!.summary.status).toBe('some-blocked');
    });

    it('should detect oracle manipulation activates oracle-adjacent guardrails', () => {
      const service = new StressMatrixService();
      const result = service.runMatrix();
      const oracleScenario = result.scenarios.find(s => s.scenarioId === 'oracle-manipulation');

      expect(oracleScenario).toBeDefined();
      expect(oracleScenario!.guardrailActivations.length).toBeGreaterThan(0);
    });

    it('should detect trust collapse activates pause condition', () => {
      const service = new StressMatrixService();
      const result = service.runMatrix();
      const trustScenario = result.scenarios.find(s => s.scenarioId === 'trust-collapse');

      expect(trustScenario).toBeDefined();
      const pauseActivations = trustScenario!.guardrailActivations.filter(
        a => a.ruleType === 'pause-condition',
      );
      expect(pauseActivations.length).toBeGreaterThan(0);
    });

    it('should correctly compute pass rate', () => {
      const service = new StressMatrixService();
      const result = service.runMatrix();

      for (const scenario of result.scenarios) {
        const { totalGuardrails, blockedCount } = scenario.summary;
        const expectedPassRate = totalGuardrails > 0
          ? ((totalGuardrails - blockedCount) / totalGuardrails) * 100
          : 0;
        expect(scenario.summary.passRate).toBeCloseTo(expectedPassRate, 0);
      }
    });
  });

  describe('matrix summary', () => {
    it('should provide correct summary totals', () => {
      const service = new StressMatrixService();
      const result = service.runMatrix();

      expect(result.summary.totalScenarios).toBe(result.scenarios.length);
      expect(result.generatedAt).toBeDefined();
      expect(new Date(result.generatedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should identify most triggered guardrails', () => {
      const service = new StressMatrixService();
      const result = service.runMatrix();

      expect(result.summary.mostTriggeredGuardrails.length).toBeGreaterThan(0);
      for (const guardrail of result.summary.mostTriggeredGuardrails) {
        expect(guardrail.triggerCount).toBeGreaterThan(0);
        expect(guardrail.ruleId).toBeDefined();
      }
    });
  });

  describe('config updates', () => {
    it('should update config at runtime', () => {
      const service = new StressMatrixService();
      service.updateConfig({ trustThreshold: 50, liquidityStressMultiplier: 0.5 });
      const config = service.getConfig();
      expect(config.trustThreshold).toBe(50);
      expect(config.liquidityStressMultiplier).toBe(0.5);
    });
  });
});
