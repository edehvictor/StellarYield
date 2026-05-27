/**
 * ThresholdLabeler
 * 
 * Categorizes fragmentation scores into Low/Medium/High levels and provides
 * descriptive text and visual indicators for each category.
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { FragmentationCategory, CategoryLabel, FragmentationError } from './types';

export class ThresholdLabeler {
  private readonly lowThreshold: number;
  private readonly highThreshold: number;

  constructor(
    lowThreshold: number = 30,
    highThreshold: number = 60
  ) {
    if (lowThreshold >= highThreshold) {
      throw new FragmentationError(
        'Invalid thresholds: lowThreshold must be less than highThreshold',
        'INVALID_THRESHOLDS',
        { lowThreshold, highThreshold }
      );
    }

    this.lowThreshold = lowThreshold;
    this.highThreshold = highThreshold;
  }

  /**
   * Categorize fragmentation score into Low/Medium/High
   * 
   * Low: score < 30
   * Medium: 30 <= score <= 60
   * High: score > 60
   * 
   * Boundary handling: scores exactly at boundaries are assigned to higher category
   * 
   * @param fragmentationScore - Fragmentation score (0-100)
   * @returns Category label with description and visual indicators
   */
  categorize(fragmentationScore: number): CategoryLabel {
    if (fragmentationScore < 0 || fragmentationScore > 100) {
      throw new FragmentationError(
        `Invalid fragmentation score: ${fragmentationScore}. Must be between 0 and 100`,
        'INVALID_SCORE',
        { score: fragmentationScore }
      );
    }

    let category: FragmentationCategory;

    if (fragmentationScore < this.lowThreshold) {
      category = 'Low';
    } else if (fragmentationScore < this.highThreshold) {
      // Boundary values (30, 60) are assigned to higher category
      // So 30 goes to Medium, 60 goes to High
      category = 'Medium';
    } else {
      category = 'High';
    }

    return {
      category,
      description: this.getDescription(category),
      ...this.getVisualIndicators(category),
      tradingImplication: this.getTradingImplication(category),
    };
  }

  /**
   * Get descriptive text for a fragmentation category
   * 
   * @param category - Fragmentation category
   * @returns Descriptive text explaining the category
   */
  getDescription(category: FragmentationCategory): string {
    switch (category) {
      case 'Low':
        return 'Liquidity is concentrated in one or two dominant protocols. Market structure is centralized with clear liquidity leaders.';
      
      case 'Medium':
        return 'Liquidity is moderately distributed across protocols. Market shows balanced competition with no single dominant player.';
      
      case 'High':
        return 'Liquidity is highly fragmented across multiple protocols. Market structure is decentralized with evenly distributed liquidity.';
      
      default:
        throw new FragmentationError(
          `Unknown category: ${category}`,
          'UNKNOWN_CATEGORY',
          { category }
        );
    }
  }

  /**
   * Get trading implication for a fragmentation category
   * 
   * @param category - Fragmentation category
   * @returns Trading implication text
   */
  private getTradingImplication(category: FragmentationCategory): string {
    switch (category) {
      case 'Low':
        return 'Single-protocol routing is typically optimal. Trades can be executed efficiently through the dominant protocol with minimal complexity.';
      
      case 'Medium':
        return 'Consider multi-protocol routing for larger trades. Execution quality may benefit from splitting orders across protocols.';
      
      case 'High':
        return 'Multi-protocol routing is recommended. Fragmented liquidity requires sophisticated routing strategies to achieve optimal execution.';
      
      default:
        throw new FragmentationError(
          `Unknown category: ${category}`,
          'UNKNOWN_CATEGORY',
          { category }
        );
    }
  }

  /**
   * Map category to visual indicators
   * 
   * @param category - Fragmentation category
   * @returns Visual indicators (color and icon)
   */
  getVisualIndicators(category: FragmentationCategory): { color: string; icon: string } {
    switch (category) {
      case 'Low':
        return {
          color: '#10b981', // Green
          icon: 'check-circle',
        };
      
      case 'Medium':
        return {
          color: '#f59e0b', // Yellow/Amber
          icon: 'alert-triangle',
        };
      
      case 'High':
        return {
          color: '#ef4444', // Red
          icon: 'alert-octagon',
        };
      
      default:
        throw new FragmentationError(
          `Unknown category: ${category}`,
          'UNKNOWN_CATEGORY',
          { category }
        );
    }
  }
}
