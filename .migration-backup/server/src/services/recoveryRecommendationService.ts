import { createGuardrailsService, GuardrailContext } from "./guardrailsService";

export type ShockEventType = "APY_CRASH" | "ORACLE_ANOMALY" | "LIQUIDITY_EVENT";

export type RecoveryPath = "HOLD" | "UNWIND" | "ROTATE" | "REBALANCE";

export interface ShockEvent {
  type: ShockEventType;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  vaultId: string;
  protocol: string;
  description: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface RecoveryRecommendation {
  path: RecoveryPath;
  confidence: number; // 0 to 1
  reasoning: string;
  steps: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}

export class RecoveryRecommendationService {
  private guardrails: { evaluateGuardrails: (ctx: GuardrailContext) => { passed: boolean } };

  constructor(guardrails?: { evaluateGuardrails: (ctx: GuardrailContext) => { passed: boolean } }) {
    this.guardrails = guardrails || (createGuardrailsService() as unknown as { evaluateGuardrails: (ctx: GuardrailContext) => { passed: boolean } });
  }

  async evaluateRecoveryOptions(
    event: ShockEvent
  ): Promise<RecoveryRecommendation[]> {
    const recommendations: RecoveryRecommendation[] = [];

    // Context for guardrails
    const context: GuardrailContext = {
      strategyId: event.vaultId,
      // In a real app, we'd fetch more context like current concentration, slippage, etc.
    };

    const healthCheck = this.guardrails.evaluateGuardrails(context);

    switch (event.type) {
      case "APY_CRASH":
        recommendations.push(...this.handleApyCrash(event, healthCheck.passed));
        break;
      case "ORACLE_ANOMALY":
        recommendations.push(...this.handleOracleAnomaly(event, healthCheck.passed));
        break;
      case "LIQUIDITY_EVENT":
        recommendations.push(...this.handleLiquidityEvent(event, healthCheck.passed));
        break;
      default:
        recommendations.push(this.getDefaultRecommendation(event));
    }

    return recommendations;
  }

  private handleApyCrash(event: ShockEvent, healthPassed: boolean): RecoveryRecommendation[] {
    const recs: RecoveryRecommendation[] = [];

    if (event.severity === "CRITICAL" || event.severity === "HIGH" || !healthPassed) {
      recs.push({
        path: "ROTATE",
        confidence: 0.9,
        reasoning: "APY has crashed significantly and protocol health is compromised or at risk. Immediate rotation to a stable strategy is recommended to preserve yield.",
        steps: [
          "Withdraw funds from current strategy",
          "Identify top 3 stable strategies using StrategyRotationService",
          "Allocate funds to the highest-scoring stable strategy"
        ],
        riskLevel: "MEDIUM",
      });
    } else {
      recs.push({
        path: "HOLD",
        confidence: 0.7,
        reasoning: "APY dip appears temporary. Guardrails are still passing. Monitoring for recovery is advised before taking disruptive action.",
        steps: [
          "Set up 24h high-frequency monitoring",
          "Set alerts for further APY drops below 5%"
        ],
        riskLevel: "LOW",
      });
      recs.push({
        path: "REBALANCE",
        confidence: 0.6,
        reasoning: "Partial rebalance to more stable pools within the same protocol could mitigate the APY crash effects without a full exit.",
        steps: [
          "Analyze pool yields within protocol",
          "Reallocate 30% of funds to higher-yielding stable pools"
        ],
        riskLevel: "LOW",
      });
    }

    return recs;
  }

  private handleOracleAnomaly(_event: ShockEvent, _healthPassed: boolean): RecoveryRecommendation[] {
    // Oracle anomalies are high risk and usually require immediate exit
    return [{
      path: "UNWIND",
      confidence: 0.98,
      reasoning: "Oracle anomaly detected. Price feeds cannot be trusted, leading to potential mispricing and loss of funds. Unwinding positions to USDC is the safest path.",
      steps: [
        "Pause all trading operations for the vault",
        "Unwind all positions to USDC or safest stable asset",
        "Wait for oracle stabilization and manual audit"
      ],
      riskLevel: "HIGH",
    }];
  }

  private handleLiquidityEvent(event: ShockEvent, _healthPassed: boolean): RecoveryRecommendation[] {
    if (event.severity === "HIGH" || event.severity === "CRITICAL") {
      return [{
        path: "UNWIND",
        confidence: 0.85,
        reasoning: "Liquidity has dried up significantly. Exiting positions now is necessary to prevent being stuck in a dead pool or suffering extreme slippage later.",
        steps: [
          "Evaluate exit slippage at current depth",
          "Execute staged withdrawal if slippage exceeds 2%",
          "Move funds to highly liquid buffers"
        ],
        riskLevel: "HIGH",
      }];
    }
    
    return [{
      path: "REBALANCE",
      confidence: 0.7,
      reasoning: "Liquidity event detected but within manageable bounds. Rebalancing to more liquid assets within the same protocol is recommended.",
      steps: [
        "Identify most liquid pairs in the protocol",
        "Shift allocation to higher liquidity pools to improve exitability"
      ],
      riskLevel: "MEDIUM",
    }];
  }

  private getDefaultRecommendation(_event: ShockEvent): RecoveryRecommendation {
    return {
      path: "HOLD",
      confidence: 0.5,
      reasoning: "Unrecognized shock event type. Holding current position and awaiting manual operator review is the safest default.",
      steps: [
        "Notify system operator",
        "Perform manual audit of protocol state"
      ],
      riskLevel: "MEDIUM",
    };
  }
}

export const recoveryRecommendationService = new RecoveryRecommendationService();
