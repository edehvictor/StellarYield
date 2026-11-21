/**
 * Compound Interest Math Utilities
 * 
 * Implements complex mathematical formulas for calculating compound interest
 * with daily compounding intervals, supporting regular deposits and comparisons.
 */

/**
 * Configuration for compound interest calculations
 */
export interface CompoundConfig {
  /** Initial principal amount in USD */
  principal: number;
  /** Annual Percentage Yield (APY) as a percentage (e.g., 8.5 for 8.5%) */
  apy: number;
  /** Monthly contribution amount in USD */
  monthlyContribution: number;
  /** Time horizon in years */
  years: number;
}

/**
 * Data point for projection charts
 */
export interface ProjectionPoint {
  /** Time period (month number) */
  period: number;
  /** Year number */
  year: number;
  /** Value with compound interest and contributions */
  compoundValue: number;
  /** Value with simple interest (no compounding) */
  simpleValue: number;
  /** Principal + contributions only (no interest) */
  principalOnly: number;
  /** Total contributions made */
  totalContributions: number;
  /** Total interest earned */
  totalInterest: number;
}

/**
 * Calculate compound interest with daily compounding and monthly contributions
 * 
 * Formula: A = P(1 + r/n)^(nt) + PMT × [((1 + r/n)^(nt) - 1) / (r/n)]
 * 
 * Where:
 * - A = Final amount
 * - P = Principal amount
 * - r = Annual interest rate (decimal)
 * - n = Number of times interest is compounded per year (365 for daily)
 * - t = Time in years
 * - PMT = Monthly payment amount
 * 
 * @param config Configuration for the calculation
 * @returns Array of monthly projection points
 */
function toSafeFinite(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  // Clamp to a finite display-safe range to avoid Infinity/overflow artifacts.
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
}

export function calculateCompoundProjection(config: CompoundConfig): ProjectionPoint[] {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return [];
  }

  const principal = config.principal;
  const apy = config.apy;
  const monthlyContribution = config.monthlyContribution;
  const years = Math.floor(config.years);

  // Convert APY percentage to decimal
  const annualRate = apy / 100;

  // Daily compounding
  const compoundsPerYear = 365;
  const dailyRate = annualRate / compoundsPerYear;

  const projections: ProjectionPoint[] = [];
  let currentPrincipal = principal;
  let totalContributions = principal;

  // Calculate projection for each month
  for (let month = 0; month <= years * 12; month++) {
    const year = Math.floor(month / 12);
    const day = month * 30.44; // Average days per month

    // Compound interest calculation with daily compounding
    const compoundFactor = toSafeFinite(Math.pow(1 + dailyRate, day), 1);

    // Calculate compound value with contributions
    let compoundValue = toSafeFinite(principal * compoundFactor);

    // Add monthly contributions with their respective compounding
    if (monthlyContribution > 0 && month > 0) {
      for (let contribMonth = 1; contribMonth <= month; contribMonth++) {
        const contribDays = (month - contribMonth) * 30.44;
        const contribCompoundFactor = toSafeFinite(Math.pow(1 + dailyRate, contribDays), 1);
        compoundValue = toSafeFinite(compoundValue + monthlyContribution * contribCompoundFactor);
      }
    }

    // Calculate simple interest (no compounding)
    const simpleInterest = toSafeFinite(currentPrincipal * annualRate * (month / 12));
    const simpleValue = toSafeFinite(currentPrincipal + simpleInterest);

    // Calculate principal only (no interest)
    const principalOnly = toSafeFinite(totalContributions);

    // Calculate total interest earned
    const totalInterest = toSafeFinite(compoundValue - totalContributions);

    projections.push({
      period: month,
      year,
      compoundValue,
      simpleValue,
      principalOnly,
      totalContributions,
      totalInterest,
    });

    // Update for next iteration
    if (month < years * 12) {
      totalContributions = toSafeFinite(totalContributions + monthlyContribution);
      currentPrincipal = toSafeFinite(currentPrincipal + monthlyContribution);
    }
  }

  return projections;
}

/**
 * Calculate key metrics from a projection
 */
export function calculateProjectionMetrics(projections: ProjectionPoint[]) {
  if (projections.length === 0) {
    return {
      finalValue: 0,
      totalContributions: 0,
      totalInterest: 0,
      totalReturnPercent: 0,
      annualizedReturn: 0,
    };
  }

  const final = projections[projections.length - 1];
  const years = final.year + (final.period % 12) / 12;

  const finalValue = Number.isFinite(final.compoundValue) ? final.compoundValue : 0;
  const totalContributions = Number.isFinite(final.totalContributions) ? final.totalContributions : 0;
  const totalInterest = Number.isFinite(final.totalInterest) ? final.totalInterest : 0;

  const totalReturnPercent =
    totalContributions > 0 ? (totalInterest / totalContributions) * 100 : 0;

  // Annualized return calculation (checked arithmetic)
  let annualizedReturn = 0;
  if (years > 0 && totalContributions > 0 && finalValue >= 0) {
    const ratio = finalValue / totalContributions;
    const computed = ratio > 0 ? (Math.pow(ratio, 1 / years) - 1) * 100 : -100;
    annualizedReturn = Number.isFinite(computed) ? computed : 0;
  }

  return {
    finalValue,
    totalContributions,
    totalInterest,
    totalReturnPercent: Number.isFinite(totalReturnPercent) ? totalReturnPercent : 0,
    annualizedReturn,
  };
}

/**
 * Format currency value with proper formatting
 */
export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Format percentage value
 */
export function formatPercentage(value: number, decimals: number = 2): string {
  if (!Number.isFinite(value)) {
    return "—%";
  }
  return `${value.toFixed(decimals)}%`;
}

/**
 * Validate configuration values
 */
export function validateConfig(config: CompoundConfig): string[] {
  const errors: string[] = [];

  if (!Number.isFinite(config.principal)) {
    errors.push('Initial deposit must be a finite number');
  } else if (config.principal < 0) {
    errors.push('Initial deposit cannot be negative');
  } else if (config.principal > 1000000000) {
    errors.push('Initial deposit exceeds maximum limit');
  }

  if (!Number.isFinite(config.apy)) {
    errors.push('APY must be a finite number');
  } else if (config.apy < 0) {
    errors.push('APY cannot be negative');
  } else if (config.apy > 1000) {
    errors.push('APY exceeds reasonable maximum');
  }

  if (!Number.isFinite(config.monthlyContribution)) {
    errors.push('Monthly contribution must be a finite number');
  } else if (config.monthlyContribution < 0) {
    errors.push('Monthly contribution cannot be negative');
  } else if (config.monthlyContribution > 1000000) {
    errors.push('Monthly contribution exceeds maximum limit');
  }

  if (!Number.isFinite(config.years)) {
    errors.push('Time horizon must be a finite number');
  } else if (config.years < 1) {
    errors.push('Time horizon must be at least 1 year');
  } else if (config.years > 50) {
    errors.push('Time horizon exceeds maximum limit');
  }

  return errors;
}
