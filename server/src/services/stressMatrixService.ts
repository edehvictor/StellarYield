import { GuardrailsService, type GuardrailContext, type GuardrailEvaluationResult } from './guardrailsService';

export type StressFactor = 'liquidity' | 'trust' | 'confidence' | 'oracle';

export interface StressScenario {
  id: string;
  name: string;
  description: string;
  factors: Partial<Record<StressFactor, number>>;
}

export interface GuardrailActivation {
  ruleId: string;
  ruleName: string;
  ruleType: string;
  activated: boolean;
  detail: string;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  scenarioDescription: string;
  guardrailActivations: GuardrailActivation[];
  summary: {
    totalGuardrails: number;
    activatedCount: number;
    blockedCount: number;
    passRate: number;
    status: 'all-passed' | 'some-blocked' | 'all-blocked';
  };
  stressFactors: Partial<Record<StressFactor, number>>;
}

export interface StressMatrixResult {
  generatedAt: string;
  scenarioCount: number;
  scenarios: ScenarioResult[];
  summary: {
    totalScenarios: number;
    totalGuardrailEvaluations: number;
    totalActivations: number;
    mostTriggeredGuardrails: Array<{ ruleId: string; ruleName: string; triggerCount: number }>;
  };
}

export interface StressMatrixConfig {
  trustThreshold: number;
  confidenceThreshold: number;
  oracleThreshold: number;
  liquidityStressMultiplier: number;
}

const DEFAULT_CONFIG: StressMatrixConfig = {
  trustThreshold: 30,
  confidenceThreshold: 40,
  oracleThreshold: 25,
  liquidityStressMultiplier: 0.7,
};

const DEFAULT_SCENARIOS: StressScenario[] = [
  {
    id: 'liquidity-crisis',
    name: 'Liquidity Crisis',
    description: 'Sharp liquidity drawdown across multiple pools simultaneously',
    factors: { liquidity: 85, trust: 40, confidence: 60, oracle: 30 },
  },
  {
    id: 'oracle-manipulation',
    name: 'Oracle Manipulation',
    description: 'Oracle price feeds deviate significantly from expected values',
    factors: { oracle: 90, trust: 70, confidence: 80, liquidity: 20 },
  },
  {
    id: 'trust-collapse',
    name: 'Trust Collapse',
    description: 'Major protocol faces exploit causing cascading trust erosion',
    factors: { trust: 95, liquidity: 60, confidence: 90, oracle: 50 },
  },
  {
    id: 'confidence-crisis',
    name: 'Confidence Crisis',
    description: 'Sustained negative yield erodes user and operator confidence',
    factors: { confidence: 85, liquidity: 40, trust: 50, oracle: 20 },
  },
  {
    id: 'multi-factor-meltdown',
    name: 'Multi-Factor Meltdown',
    description: 'Simultaneous stress across all factors at extreme levels',
    factors: { liquidity: 95, trust: 90, confidence: 95, oracle: 85 },
  },
  {
    id: 'mild-downturn',
    name: 'Mild Downturn',
    description: 'Gentle market decline with moderate factor pressure',
    factors: { liquidity: 15, trust: 10, confidence: 15, oracle: 5 },
  },
];

function mapStressToGuardrailContext(factors: Partial<Record<StressFactor, number>>, config: StressMatrixConfig): GuardrailContext {
  const liquidity = factors.liquidity ?? 0;
  const trust = factors.trust ?? 0;
  const confidence = factors.confidence ?? 0;
  const oracle = factors.oracle ?? 0;

  const concentration = 30 + (trust * 0.3) + (confidence * 0.2);
  const slippage = 1 + (liquidity * 0.04) + (oracle * 0.02);
  const rawLiquidity = 1_000_000 - (liquidity * 10_000 * config.liquidityStressMultiplier);
  const minLiquidityVal = Math.max(10_000, rawLiquidity);

  return {
    strategyId: 'stress-matrix',
    concentration: Math.min(100, concentration),
    slippage: Math.min(20, slippage),
    liquidity: minLiquidityVal,
    isMarketPaused: trust > config.trustThreshold || oracle > config.oracleThreshold,
  };
}

export class StressMatrixService {
  private guardrailsService: GuardrailsService;
  private config: StressMatrixConfig;
  private scenarios: StressScenario[];

  constructor(
    guardrailsService?: GuardrailsService,
    config: Partial<StressMatrixConfig> = {},
    scenarios: StressScenario[] = DEFAULT_SCENARIOS,
  ) {
    this.guardrailsService = guardrailsService ?? new GuardrailsService();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scenarios = scenarios.map(s => ({ ...s, factors: { ...s.factors } }));
  }

  runMatrix(): StressMatrixResult {
    const scenarioResults: ScenarioResult[] = [];

    for (const scenario of this.scenarios) {
      const context = mapStressToGuardrailContext(scenario.factors, this.config);
      const evaluation: GuardrailEvaluationResult = this.guardrailsService.evaluateGuardrails(context);

      const activations: GuardrailActivation[] = evaluation.blockedRules.length > 0
        ? evaluation.blockedRules.map(rule => ({
            ruleId: rule.id,
            ruleName: rule.name,
            ruleType: rule.type,
            activated: true,
            detail: `Blocked by ${rule.name}: ${rule.description}`,
          }))
        : [];

      const allRules = this.guardrailsService.getAllRules();
      const enabledRules = allRules.filter(r => r.enabled);
      const activatedCount = activations.length;
      const blockedCount = activations.length;
      const totalGuardrails = enabledRules.length;
      const passRate = totalGuardrails > 0 ? ((totalGuardrails - blockedCount) / totalGuardrails) * 100 : 0;

      let status: ScenarioResult['summary']['status'];
      if (blockedCount === 0) {
        status = 'all-passed';
      } else if (blockedCount >= totalGuardrails) {
        status = 'all-blocked';
      } else {
        status = 'some-blocked';
      }

      scenarioResults.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        scenarioDescription: scenario.description,
        guardrailActivations: activations,
        summary: {
          totalGuardrails,
          activatedCount,
          blockedCount,
          passRate: Math.round(passRate * 100) / 100,
          status,
        },
        stressFactors: scenario.factors,
      });
    }

    const totalEvaluations = scenarioResults.reduce((s, r) => s + r.summary.totalGuardrails, 0);
    const totalActivations = scenarioResults.reduce((s, r) => s + r.summary.activatedCount, 0);

    const triggerMap = new Map<string, { ruleId: string; ruleName: string; triggerCount: number }>();
    for (const sr of scenarioResults) {
      for (const ga of sr.guardrailActivations) {
        const existing = triggerMap.get(ga.ruleId);
        if (existing) {
          existing.triggerCount++;
        } else {
          triggerMap.set(ga.ruleId, { ruleId: ga.ruleId, ruleName: ga.ruleName, triggerCount: 1 });
        }
      }
    }

    const mostTriggeredGuardrails = Array.from(triggerMap.values())
      .sort((a, b) => b.triggerCount - a.triggerCount);

    return {
      generatedAt: new Date().toISOString(),
      scenarioCount: this.scenarios.length,
      scenarios: scenarioResults,
      summary: {
        totalScenarios: this.scenarios.length,
        totalGuardrailEvaluations: totalEvaluations,
        totalActivations,
        mostTriggeredGuardrails,
      },
    };
  }

  addScenario(scenario: StressScenario): void {
    this.scenarios.push(scenario);
  }

  removeScenario(scenarioId: string): boolean {
    const idx = this.scenarios.findIndex(s => s.id === scenarioId);
    if (idx === -1) return false;
    this.scenarios.splice(idx, 1);
    return true;
  }

  getScenarios(): StressScenario[] {
    return [...this.scenarios];
  }

  updateConfig(config: Partial<StressMatrixConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): StressMatrixConfig {
    return { ...this.config };
  }
}

export const stressMatrixService = new StressMatrixService();
