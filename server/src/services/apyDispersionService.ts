export interface ProviderApyInput {
  provider: string;
  apy: number;
  tvlUsd: number;
  fetchedAt: string;
}

export interface ApyDispersionResult {
  strategyId: string;
  strategyName: string;
  providerCount: number;
  apyValues: number[];
  meanApy: number;
  medianApy: number;
  minApy: number;
  maxApy: number;
  range: number;
  variance: number;
  stdDev: number;
  coefficientOfVariation: number;
  dispersionLevel: 'low' | 'moderate' | 'high' | 'critical';
  confidenceSignal: 'high' | 'reduced' | 'low' | 'warning';
  sources: Array<{
    provider: string;
    apy: number;
    tvlUsd: number;
    deviationFromMean: number;
  }>;
  warning: string | null;
}

export interface DispersionConfig {
  lowCvThreshold: number;
  moderateCvThreshold: number;
  highCvThreshold: number;
  criticalCvThreshold: number;
}

const DEFAULT_CONFIG: DispersionConfig = {
  lowCvThreshold: 0.05,
  moderateCvThreshold: 0.15,
  highCvThreshold: 0.30,
  criticalCvThreshold: 0.50,
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function variance(values: number[], meanVal: number): number {
  if (values.length <= 1) return 0;
  return values.reduce((s, v) => s + (v - meanVal) ** 2, 0) / values.length;
}

function stdDev(varianceVal: number): number {
  return Math.sqrt(varianceVal);
}

function roundTo(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeDispersionLevel(cv: number, config: DispersionConfig): ApyDispersionResult['dispersionLevel'] {
  if (cv <= config.lowCvThreshold) return 'low';
  if (cv <= config.moderateCvThreshold) return 'moderate';
  if (cv <= config.highCvThreshold) return 'high';
  return 'critical';
}

function computeConfidenceSignal(dispersionLevel: ApyDispersionResult['dispersionLevel'], providerCount: number): ApyDispersionResult['confidenceSignal'] {
  if (dispersionLevel === 'low' && providerCount >= 3) return 'high';
  if (dispersionLevel === 'moderate' && providerCount >= 2) return 'reduced';
  if (dispersionLevel === 'high') return 'low';
  return 'warning';
}

function buildWarning(dispersionLevel: ApyDispersionResult['dispersionLevel'], cv: number): string | null {
  if (dispersionLevel === 'low') return null;
  if (dispersionLevel === 'moderate') return `Moderate APY dispersion detected (CV=${roundTo(cv, 3)}). Consider cross-referencing sources.`;
  if (dispersionLevel === 'high') return `High APY dispersion detected (CV=${roundTo(cv, 3)}). Provider disagreement is significant.`;
  return `Critical APY dispersion detected (CV=${roundTo(cv, 3)}). Data may be unreliable - investigate provider inputs.`;
}

export class ApyDispersionService {
  private config: DispersionConfig;

  constructor(config: Partial<DispersionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  computeDispersion(strategyId: string, strategyName: string, inputs: ProviderApyInput[]): ApyDispersionResult {
    if (inputs.length === 0) {
      return {
        strategyId,
        strategyName,
        providerCount: 0,
        apyValues: [],
        meanApy: 0,
        medianApy: 0,
        minApy: 0,
        maxApy: 0,
        range: 0,
        variance: 0,
        stdDev: 0,
        coefficientOfVariation: 0,
        dispersionLevel: 'low',
        confidenceSignal: 'warning',
        sources: [],
        warning: 'No provider inputs available for dispersion analysis.',
      };
    }

    const apyValues = inputs.map(i => i.apy);
    const meanApy = mean(apyValues);
    const medianApy = median(apyValues);
    const minApy = Math.min(...apyValues);
    const maxApy = Math.max(...apyValues);
    const range = maxApy - minApy;
    const varianceVal = variance(apyValues, meanApy);
    const stdDevVal = stdDev(varianceVal);
    const coefficientOfVariation = meanApy !== 0 ? stdDevVal / Math.abs(meanApy) : 0;

    const dispersionLevel = computeDispersionLevel(coefficientOfVariation, this.config);
    const confidenceSignal = computeConfidenceSignal(dispersionLevel, inputs.length);

    const sources = inputs.map(input => ({
      provider: input.provider,
      apy: input.apy,
      tvlUsd: input.tvlUsd,
      deviationFromMean: roundTo(input.apy - meanApy),
    }));

    const warning = buildWarning(dispersionLevel, coefficientOfVariation);

    return {
      strategyId,
      strategyName,
      providerCount: inputs.length,
      apyValues,
      meanApy: roundTo(meanApy),
      medianApy: roundTo(medianApy),
      minApy,
      maxApy,
      range: roundTo(range),
      variance: roundTo(varianceVal),
      stdDev: roundTo(stdDevVal),
      coefficientOfVariation: roundTo(coefficientOfVariation),
      dispersionLevel,
      confidenceSignal,
      sources,
      warning,
    };
  }

  updateConfig(config: Partial<DispersionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): DispersionConfig {
    return { ...this.config };
  }
}

export const apyDispersionService = new ApyDispersionService();
