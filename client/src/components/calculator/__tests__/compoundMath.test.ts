import { describe, it, expect } from 'vitest';
import type { CompoundConfig } from '../compoundMath';
import {
  calculateCompoundProjection,
  calculateProjectionMetrics,
  formatCurrency,
  formatPercentage,
  validateConfig,
} from '../compoundMath';

describe('Compound Math Utilities', () => {
  const defaultConfig: CompoundConfig = {
    principal: 10000,
    apy: 8.5,
    monthlyContribution: 500,
    years: 5,
  };

  describe('calculateCompoundProjection', () => {
    it('should calculate correct projection for basic config', () => {
      const projections = calculateCompoundProjection(defaultConfig);
      
      expect(projections).toHaveLength(61); // 5 years * 12 months + initial
      expect(projections[0]).toEqual({
        period: 0,
        year: 0,
        compoundValue: 10000,
        simpleValue: 10000,
        principalOnly: 10000,
        totalContributions: 10000,
        totalInterest: 0,
      });
      
      // Final value should be greater than principal + contributions
      const final = projections[projections.length - 1];
      const totalContributions = 10000 + (500 * 5 * 12);
      expect(final.compoundValue).toBeGreaterThan(totalContributions);
      expect(final.totalInterest).toBeGreaterThan(0);
    });

    it('should handle zero monthly contributions', () => {
      const config = { ...defaultConfig, monthlyContribution: 0 };
      const projections = calculateCompoundProjection(config);
      
      expect(projections).toHaveLength(61);
      const final = projections[projections.length - 1];
      expect(final.totalContributions).toBe(10000);
      expect(final.compoundValue).toBeGreaterThan(10000);
    });

    it('should handle zero initial principal', () => {
      const config = { ...defaultConfig, principal: 0 };
      const projections = calculateCompoundProjection(config);
      
      expect(projections).toHaveLength(61);
      expect(projections[0].compoundValue).toBe(0);
      
      const final = projections[projections.length - 1];
      expect(final.compoundValue).toBeGreaterThan(0);
      expect(final.totalContributions).toBe(500 * 5 * 12);
    });

    it('should handle 1 year projection', () => {
      const config = { ...defaultConfig, years: 1 };
      const projections = calculateCompoundProjection(config);
      
      expect(projections).toHaveLength(13); // 12 months + initial
      expect(projections[projections.length - 1].year).toBe(1);
    });

    it('should handle 10 year projection', () => {
      const config = { ...defaultConfig, years: 10 };
      const projections = calculateCompoundProjection(config);
      
      expect(projections).toHaveLength(121); // 120 months + initial
      expect(projections[projections.length - 1].year).toBe(10);
    });

    it('should have compound value greater than principal only', () => {
      const projections = calculateCompoundProjection(defaultConfig);
      
      // Compound value should always be greater than principal only when APY > 0
      for (let i = 1; i < projections.length; i++) {
        expect(projections[i].compoundValue).toBeGreaterThan(projections[i].principalOnly);
      }
    });

    it('should handle edge case of very high APY', () => {
      const config = { ...defaultConfig, apy: 100 };
      const projections = calculateCompoundProjection(config);
      
      expect(projections).toHaveLength(61);
      const final = projections[projections.length - 1];
      expect(final.compoundValue).toBeGreaterThan(final.totalContributions * 2);
    });
  });

  describe('calculateProjectionMetrics', () => {
    it('should calculate correct metrics', () => {
      const projections = calculateCompoundProjection(defaultConfig);
      const metrics = calculateProjectionMetrics(projections);
      
      expect(metrics.finalValue).toBeGreaterThan(0);
      expect(metrics.totalContributions).toBe(10000 + (500 * 5 * 12));
      expect(metrics.totalInterest).toBeGreaterThan(0);
      expect(metrics.totalReturnPercent).toBeGreaterThan(0);
      expect(metrics.annualizedReturn).toBeGreaterThan(0);
    });

    it('should handle empty projections', () => {
      const metrics = calculateProjectionMetrics([]);
      
      expect(metrics).toEqual({
        finalValue: 0,
        totalContributions: 0,
        totalInterest: 0,
        totalReturnPercent: 0,
        annualizedReturn: 0,
      });
    });

    it('should calculate annualized return correctly', () => {
      // Test with known values
      const config = { ...defaultConfig, principal: 1000, monthlyContribution: 0, years: 1 };
      const projections = calculateCompoundProjection(config);
      const metrics = calculateProjectionMetrics(projections);
      
      // Annualized return should be close to APY for 1 year with no contributions
      // Allow for some difference due to daily compounding vs annual rate
      expect(metrics.annualizedReturn).toBeCloseTo(config.apy, 0);
    });
  });

  describe('formatCurrency', () => {
    it('should format positive numbers correctly', () => {
      expect(formatCurrency(1234.56)).toBe('$1,235');
      expect(formatCurrency(1000000)).toBe('$1,000,000');
      expect(formatCurrency(0)).toBe('$0');
    });

    it('should format large numbers correctly', () => {
      expect(formatCurrency(1234567890)).toBe('$1,234,567,890');
    });

    it('should handle decimal values', () => {
      expect(formatCurrency(1234.99)).toBe('$1,235');
    });
  });

  describe('formatPercentage', () => {
    it('should format percentages correctly', () => {
      expect(formatPercentage(8.5)).toBe('8.50%');
      expect(formatPercentage(100)).toBe('100.00%');
      expect(formatPercentage(0.123)).toBe('0.12%');
    });

    it('should respect decimal parameter', () => {
      expect(formatPercentage(8.5, 1)).toBe('8.5%');
      expect(formatPercentage(8.5, 0)).toBe('9%');
      expect(formatPercentage(8.5, 3)).toBe('8.500%');
    });

    it('should handle negative percentages', () => {
      expect(formatPercentage(-5.25)).toBe('-5.25%');
    });
  });

  describe('validateConfig', () => {
    it('should validate correct config', () => {
      const errors = validateConfig(defaultConfig);
      expect(errors).toHaveLength(0);
    });

    it('should detect negative principal', () => {
      const config = { ...defaultConfig, principal: -100 };
      const errors = validateConfig(config);
      expect(errors).toContain('Initial deposit cannot be negative');
    });

    it('should detect excessive principal', () => {
      const config = { ...defaultConfig, principal: 1000000001 };
      const errors = validateConfig(config);
      expect(errors).toContain('Initial deposit exceeds maximum limit');
    });

    it('should detect negative APY', () => {
      const config = { ...defaultConfig, apy: -1 };
      const errors = validateConfig(config);
      expect(errors).toContain('APY cannot be negative');
    });

    it('should detect excessive APY', () => {
      const config = { ...defaultConfig, apy: 1001 };
      const errors = validateConfig(config);
      expect(errors).toContain('APY exceeds reasonable maximum');
    });

    it('should detect negative monthly contribution', () => {
      const config = { ...defaultConfig, monthlyContribution: -100 };
      const errors = validateConfig(config);
      expect(errors).toContain('Monthly contribution cannot be negative');
    });

    it('should detect excessive monthly contribution', () => {
      const config = { ...defaultConfig, monthlyContribution: 1000001 };
      const errors = validateConfig(config);
      expect(errors).toContain('Monthly contribution exceeds maximum limit');
    });

    it('should detect insufficient time horizon', () => {
      const config = { ...defaultConfig, years: 0 };
      const errors = validateConfig(config);
      expect(errors).toContain('Time horizon must be at least 1 year');
    });

    it('should detect excessive time horizon', () => {
      const config = { ...defaultConfig, years: 51 };
      const errors = validateConfig(config);
      expect(errors).toContain('Time horizon exceeds maximum limit');
    });

    it('should detect multiple errors', () => {
      const config = {
        principal: -100,
        apy: -5,
        monthlyContribution: -50,
        years: 0,
      };
      const errors = validateConfig(config);
      expect(errors.length).toBeGreaterThan(3);
    });
  });

  describe('edge cases', () => {
    it('should handle zero APY', () => {
      const config = { ...defaultConfig, apy: 0 };
      const projections = calculateCompoundProjection(config);
      
      // With zero APY, compound value should equal principal + contributions
      const final = projections[projections.length - 1];
      expect(final.compoundValue).toBeCloseTo(final.totalContributions, 2);
      expect(final.totalInterest).toBeCloseTo(0, 2);
    });

    it('should handle very small values', () => {
      const config = { ...defaultConfig, principal: 1, monthlyContribution: 1 };
      const projections = calculateCompoundProjection(config);
      
      expect(projections).toHaveLength(61);
      expect(projections[0].compoundValue).toBe(1);
    });

    it('should handle fractional months correctly', () => {
      const config = { ...defaultConfig, years: 0.5 }; // 6 months
      const projections = calculateCompoundProjection(config);
      
      // Should handle fractional years
      expect(projections.length).toBeGreaterThan(6);
    });
  });
});
