/**
 * Unit tests for ThresholdLabeler
 * 
 * These tests verify specific boundary conditions and edge cases.
 */

import { ThresholdLabeler } from '../../services/fragmentation/ThresholdLabeler';
import { FragmentationError } from '../../services/fragmentation/types';

describe('ThresholdLabeler - Unit Tests', () => {
  let labeler: ThresholdLabeler;

  beforeEach(() => {
    labeler = new ThresholdLabeler();
  });

  describe('categorize', () => {
    describe('boundary conditions', () => {
      it('assigns Low for score of 0', () => {
        const result = labeler.categorize(0);
        expect(result.category).toBe('Low');
      });

      it('assigns Low for score just below 30', () => {
        const result = labeler.categorize(29.99);
        expect(result.category).toBe('Low');
      });

      it('assigns Medium for score exactly 30', () => {
        const result = labeler.categorize(30);
        expect(result.category).toBe('Medium');
      });

      it('assigns Medium for score between 30 and 60', () => {
        const result = labeler.categorize(45);
        expect(result.category).toBe('Medium');
      });

      it('assigns Medium for score just below 60', () => {
        const result = labeler.categorize(59.99);
        expect(result.category).toBe('Medium');
      });

      it('assigns High for score exactly 60', () => {
        const result = labeler.categorize(60);
        expect(result.category).toBe('High');
      });

      it('assigns High for score just above 60', () => {
        const result = labeler.categorize(60.01);
        expect(result.category).toBe('High');
      });

      it('assigns High for score of 100', () => {
        const result = labeler.categorize(100);
        expect(result.category).toBe('High');
      });
    });

    describe('error handling', () => {
      it('throws error for score below 0', () => {
        expect(() => labeler.categorize(-1)).toThrow(FragmentationError);
        expect(() => labeler.categorize(-1)).toThrow('Invalid fragmentation score');
      });

      it('throws error for score above 100', () => {
        expect(() => labeler.categorize(101)).toThrow(FragmentationError);
        expect(() => labeler.categorize(101)).toThrow('Invalid fragmentation score');
      });
    });

    describe('complete result structure', () => {
      it('returns all required fields for Low category', () => {
        const result = labeler.categorize(15);
        expect(result.category).toBe('Low');
        expect(result.description).toBeDefined();
        expect(result.color).toBeDefined();
        expect(result.icon).toBeDefined();
        expect(result.tradingImplication).toBeDefined();
      });

      it('returns all required fields for Medium category', () => {
        const result = labeler.categorize(45);
        expect(result.category).toBe('Medium');
        expect(result.description).toBeDefined();
        expect(result.color).toBeDefined();
        expect(result.icon).toBeDefined();
        expect(result.tradingImplication).toBeDefined();
      });

      it('returns all required fields for High category', () => {
        const result = labeler.categorize(75);
        expect(result.category).toBe('High');
        expect(result.description).toBeDefined();
        expect(result.color).toBeDefined();
        expect(result.icon).toBeDefined();
        expect(result.tradingImplication).toBeDefined();
      });
    });
  });

  describe('getDescription', () => {
    it('returns non-empty description for Low category', () => {
      const description = labeler.getDescription('Low');
      expect(description.length).toBeGreaterThan(0);
      expect(description).toContain('concentrated');
    });

    it('returns non-empty description for Medium category', () => {
      const description = labeler.getDescription('Medium');
      expect(description.length).toBeGreaterThan(0);
      expect(description).toContain('moderately');
    });

    it('returns non-empty description for High category', () => {
      const description = labeler.getDescription('High');
      expect(description.length).toBeGreaterThan(0);
      expect(description).toContain('fragmented');
    });
  });

  describe('getVisualIndicators', () => {
    it('returns green color for Low category', () => {
      const indicators = labeler.getVisualIndicators('Low');
      expect(indicators.color).toBe('#10b981'); // Green
      expect(indicators.icon).toBe('check-circle');
    });

    it('returns yellow color for Medium category', () => {
      const indicators = labeler.getVisualIndicators('Medium');
      expect(indicators.color).toBe('#f59e0b'); // Yellow/Amber
      expect(indicators.icon).toBe('alert-triangle');
    });

    it('returns red color for High category', () => {
      const indicators = labeler.getVisualIndicators('High');
      expect(indicators.color).toBe('#ef4444'); // Red
      expect(indicators.icon).toBe('alert-octagon');
    });
  });

  describe('custom thresholds', () => {
    it('supports custom threshold values', () => {
      const customLabeler = new ThresholdLabeler(40, 70);

      expect(customLabeler.categorize(35).category).toBe('Low');
      expect(customLabeler.categorize(40).category).toBe('Medium');
      expect(customLabeler.categorize(55).category).toBe('Medium');
      expect(customLabeler.categorize(70).category).toBe('High');
      expect(customLabeler.categorize(85).category).toBe('High');
    });

    it('throws error if lowThreshold >= highThreshold', () => {
      expect(() => new ThresholdLabeler(60, 30)).toThrow(FragmentationError);
      expect(() => new ThresholdLabeler(50, 50)).toThrow(FragmentationError);
    });
  });
});
