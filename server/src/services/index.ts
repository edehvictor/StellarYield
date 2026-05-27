// Analytics Services Export
export { portfolioAttributionEngine } from './portfolioAttributionService';
export { protocolCompatibilityEngine } from './protocolCompatibilityService';
export { strategyHealthEngine } from './strategyHealthService';
export { yieldReliabilityEngine } from './yieldReliabilityService';
export { opportunityMomentumEngine } from './opportunityMomentumEngine';

// Fallback Tree Service
export { fallbackTreeRegistry } from './fallbackTreeService';
export {
  validateFallbackTree,
  traverseFallbackTree,
  createFallbackTreeFromList,
  formatTraversalResult,
  extractFailedNodes,
  DEFAULT_FALLBACK_CONFIG,
} from './fallbackTreeService';
export type * from './fallbackTreeService';

// Fallback Tree Integration
export {
  getStrategyRecommendation,
  getRotatedStrategyRecommendation,
  getProtocolFallbackRecommendation,
  getHealthPrioritizedRecommendation,
  getFallbackTreeStatistics,
  getStrategyRecommendationHistory,
  createStrategyFallbackTree,
} from './fallbackTreeIntegration';
export type * from './fallbackTreeIntegration';

// Export types for analytics
export type * from './portfolioAttributionService';
export type * from './protocolCompatibilityService';
export type * from './strategyHealthService';
export type * from './yieldReliabilityService';
export type * from './opportunityMomentumEngine';
export * from "./conversionRiskService";
export * from "./portfolioRegimeShiftService";
