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
export function calculateCompoundProjection(config: CompoundConfig): ProjectionPoint[] {
  const { principal, apy, monthlyContribution, years } = config;
  
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
    const compoundFactor = Math.pow(1 + dailyRate, day);
    
    // Calculate compound value with contributions
    let compoundValue = principal * compoundFactor;
    
    // Add monthly contributions with their respective compounding
    if (monthlyContribution > 0 && month > 0) {
      for (let contribMonth = 1; contribMonth <= month; contribMonth++) {
        const contribDays = (month - contribMonth) * 30.44;
        const contribCompoundFactor = Math.pow(1 + dailyRate, contribDays);
        compoundValue += monthlyContribution * contribCompoundFactor;
      }
    }
    
    // Calculate simple interest (no compounding)
    const simpleInterest = currentPrincipal * annualRate * (month / 12);
    const simpleValue = currentPrincipal + simpleInterest;
    
    // Calculate principal only (no interest)
    const principalOnly = totalContributions;
    
    // Calculate total interest earned
    const totalInterest = compoundValue - totalContributions;
    
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
      totalContributions += monthlyContribution;
      currentPrincipal += monthlyContribution;
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
  
  const totalReturnPercent = final.totalContributions > 0 
    ? (final.totalInterest / final.totalContributions) * 100 
    : 0;
  
  // Annualized return calculation
  const annualizedReturn = years > 0 && final.totalContributions > 0
    ? (Math.pow(final.compoundValue / final.totalContributions, 1 / years) - 1) * 100
    : 0;
  
  return {
    finalValue: final.compoundValue,
    totalContributions: final.totalContributions,
    totalInterest: final.totalInterest,
    totalReturnPercent,
    annualizedReturn,
  };
}

/**
 * Format currency value with proper formatting
 */
export function formatCurrency(value: number): string {
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
  return `${value.toFixed(decimals)}%`;
}

/**
 * Validate configuration values
 */
export function validateConfig(config: CompoundConfig): string[] {
  const errors: string[] = [];
  
  if (config.principal < 0) {
    errors.push('Initial deposit cannot be negative');
  }
  
  if (config.principal > 1000000000) {
    errors.push('Initial deposit exceeds maximum limit');
  }
  
  if (config.apy < 0) {
    errors.push('APY cannot be negative');
  }
  
  if (config.apy > 1000) {
    errors.push('APY exceeds reasonable maximum');
  }
  
  if (config.monthlyContribution < 0) {
    errors.push('Monthly contribution cannot be negative');
  }
  
  if (config.monthlyContribution > 1000000) {
    errors.push('Monthly contribution exceeds maximum limit');
  }
  
  if (config.years < 1) {
    errors.push('Time horizon must be at least 1 year');
  }
  
  if (config.years > 50) {
    errors.push('Time horizon exceeds maximum limit');
  }
  
  return errors;
}
