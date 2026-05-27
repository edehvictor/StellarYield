/**
 * Property-based tests for ThresholdLabeler
 * 
 * These tests verify universal correctness properties for threshold categorization.
 */

import fc from 'fast-check';
import { ThresholdLabeler } from '../../services/fragmentation/ThresholdLabeler';
import { FragmentationCategory } from '../../services/fragmentation/types';

describe('ThresholdLabeler - Property Tests', () => {
  let labeler: ThresholdLabeler;

  beforeEach(() => {
    labeler = new ThresholdLabeler();
  });

  /**
   * Property 13: Threshold Categorization Completeness
   * 
   * For all fragmentation scores in [0, 100], the Threshold Labeler SHALL
   * assign exactly one category from {Low, Medium, High}.
   * 
   * Validates: Requirements 5.1, 5.2, 5.3, 10.1, 10.2
   */
  describe('Property 13: Threshold Categorization Completeness', () => {
    it('assigns exactly one category for all scores in [0, 100]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          (score: number) => {
            const result = labeler.categorize(score);

            // Must have exactly one category
            expect(result.category).toBeDefined();
            expect(['Low', 'Medium', 'High']).toContain(result.category);

            // Category must be one of the three valid values
            const validCategories: FragmentationCategory[] = ['Low', 'Medium', 'High'];
            expect(validCategories).toContain(result.category);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('assigns Low for scores below 30', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 29 }),
          (score: number) => {
            const result = labeler.categorize(score);
            expect(result.category).toBe('Low');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('assigns Medium for scores between 30 and 59 (30 inclusive, 60 exclusive)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 30, max: 59 }),
          (score: number) => {
            const result = labeler.categorize(score);
            expect(result.category).toBe('Medium');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('assigns High for scores above 60', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 61, max: 100 }),
          (score: number) => {
            const result = labeler.categorize(score);
            expect(result.category).toBe('High');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 14: Threshold Boundary Handling
   * 
   * For any fragmentation score exactly equal to a boundary value (30 or 60),
   * the Threshold Labeler SHALL assign the higher category.
   * 
   * Validates: Requirements 10.3
   */
  describe('Property 14: Threshold Boundary Handling', () => {
    it('assigns Medium for score exactly 30 (boundary)', () => {
      const result = labeler.categorize(30);
      expect(result.category).toBe('Medium');
    });

    it('assigns High for score exactly 60 (boundary)', () => {
      const result = labeler.categorize(60);
      expect(result.category).toBe('High');
    });

    it('assigns Low for score just below 30', () => {
      const result = labeler.categorize(29.99);
      expect(result.category).toBe('Low');
    });

    it('assigns Medium for score just below 60', () => {
      const result = labeler.categorize(59.99);
      expect(result.category).toBe('Medium');
    });
  });

  /**
   * Property 15: Category Description Presence
   * 
   * For all fragmentation categories {Low, Medium, High}, the Threshold Labeler
   * SHALL provide a non-empty descriptive text string explaining the trading implications.
   * 
   * Validates: Requirements 5.4
   */
  describe('Property 15: Category Description Presence', () => {
    it('provides non-empty descriptions for all categories', () => {
      const categories: FragmentationCategory[] = ['Low', 'Medium', 'High'];

      for (const category of categories) {
        const description = labeler.getDescription(category);
        expect(description).toBeDefined();
        expect(description.length).toBeGreaterThan(0);
        expect(typeof description).toBe('string');
      }
    });

    it('provides non-empty descriptions for all scores', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          (score: number) => {
            const result = labeler.categorize(score);
            expect(result.description).toBeDefined();
            expect(result.description.length).toBeGreaterThan(0);
            expect(typeof result.description).toBe('string');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('provides non-empty trading implications for all scores', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          (score: number) => {
            const result = labeler.categorize(score);
            expect(result.tradingImplication).toBeDefined();
            expect(result.tradingImplication.length).toBeGreaterThan(0);
            expect(typeof result.tradingImplication).toBe('string');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 16: Visual Indicator Mapping
   * 
   * For all fragmentation categories {Low, Medium, High}, the Threshold Labeler
   * SHALL provide non-empty color and icon identifiers for UI rendering.
   * 
   * Validates: Requirements 5.5
   */
  describe('Property 16: Visual Indicator Mapping', () => {
    it('provides non-empty visual indicators for all categories', () => {
      const categories: FragmentationCategory[] = ['Low', 'Medium', 'High'];

      for (const category of categories) {
        const indicators = labeler.getVisualIndicators(category);
        expect(indicators.color).toBeDefined();
        expect(indicators.color.length).toBeGreaterThan(0);
        expect(typeof indicators.color).toBe('string');
        expect(indicators.icon).toBeDefined();
        expect(indicators.icon.length).toBeGreaterThan(0);
        expect(typeof indicators.icon).toBe('string');
      }
    });

    it('provides non-empty visual indicators for all scores', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          (score: number) => {
            const result = labeler.categorize(score);
            expect(result.color).toBeDefined();
            expect(result.color.length).toBeGreaterThan(0);
            expect(typeof result.color).toBe('string');
            expect(result.icon).toBeDefined();
            expect(result.icon.length).toBeGreaterThan(0);
            expect(typeof result.icon).toBe('string');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('provides distinct colors for different categories', () => {
      const lowIndicators = labeler.getVisualIndicators('Low');
      const mediumIndicators = labeler.getVisualIndicators('Medium');
      const highIndicators = labeler.getVisualIndicators('High');

      // Colors should be distinct
      expect(lowIndicators.color).not.toBe(mediumIndicators.color);
      expect(mediumIndicators.color).not.toBe(highIndicators.color);
      expect(lowIndicators.color).not.toBe(highIndicators.color);
    });
  });

  /**
   * Property 25: Threshold Labeler Idempotence
   * 
   * For any fragmentation score, calling the Threshold Labeler multiple times
   * with the same score SHALL always return the same category.
   * 
   * Validates: Requirements 10.4
   */
  describe('Property 25: Threshold Labeler Idempotence', () => {
    it('returns same category for repeated calls with same score', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          (score: number) => {
            // Call categorize 10 times with the same score
            const results = Array.from({ length: 10 }, () => labeler.categorize(score));

            // All results should have the same category
            const firstCategory = results[0].category;
            for (const result of results) {
              expect(result.category).toBe(firstCategory);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns same description for repeated calls with same score', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          (score: number) => {
            const results = Array.from({ length: 10 }, () => labeler.categorize(score));

            const firstDescription = results[0].description;
            for (const result of results) {
              expect(result.description).toBe(firstDescription);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns same visual indicators for repeated calls with same score', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          (score: number) => {
            const results = Array.from({ length: 10 }, () => labeler.categorize(score));

            const firstColor = results[0].color;
            const firstIcon = results[0].icon;
            for (const result of results) {
              expect(result.color).toBe(firstColor);
              expect(result.icon).toBe(firstIcon);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
