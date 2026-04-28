/**
 * Protocol Dependency Blast Radius Analyzer (#389)
 *
 * Quantifies how much of the platform would be affected if a given protocol,
 * oracle, or provider became unavailable.
 *
 * SECURITY: Blast-radius metrics stay operationally useful without exposing
 * secrets or internal credentials.
 */

import NodeCache from "node-cache";
import { freezeService } from "./freezeService";

// ── Types ───────────────────────────────────────────────────────────────

export type DependencyType = "protocol" | "oracle" | "provider" | "infrastructure" | "smart_contract";

export interface Dependency {
  /** Unique identifier for the dependency */
  id: string;
  /** Human-readable name */
  name: string;
  /** Type of dependency */
  type: DependencyType;
  /** Criticality level */
  criticality: "critical" | "high" | "medium" | "low";
  /** Description of what this dependency provides */
  description: string;
}

export interface DependencyEdge {
  /** Source dependency ID */
  from: string;
  /** Target dependency ID (what it depends on) */
  to: string;
  /** Nature of the dependency */
  relationship: "uses" | "relies_on" | "integrates_with" | "depends_on";
  /** Impact weight (0-1) */
  impactWeight: number;
}

export interface AffectedEntity {
  /** Entity identifier (strategy, asset, etc.) */
  entityId: string;
  /** Entity type */
  entityType: "strategy" | "asset" | "vault" | "service";
  /** Entity name */
  entityName: string;
  /** Impact severity */
  impactSeverity: "critical" | "high" | "medium" | "low";
  /** Estimated impact percentage (0-100) */
  impactPercentage: number;
  /** Description of impact */
  impactDescription: string;
}

export interface BlastRadiusResult {
  /** The dependency that failed */
  failedDependency: Dependency;
  /** Total number of affected entities */
  totalAffected: number;
  /** List of affected entities */
  affectedEntities: AffectedEntity[];
  /** Blast radius score (0-100, higher = more impact) */
  blastRadiusScore: number;
  /** Classification of blast radius */
  classification: "catastrophic" | "severe" | "moderate" | "minimal";
  /** Cascading failure depth (how many hops) */
  cascadeDepth: number;
  /** Estimated recovery time (hours) */
  estimatedRecoveryHours: number;
  /** Recommended actions */
  recommendedActions: string[];
  /** Timestamp of analysis */
  analyzedAt: string;
  /** Disclaimer that metrics are operational, not security-sensitive */
  disclaimer: string;
}

export interface DependencyGraph {
  nodes: Dependency[];
  edges: DependencyEdge[];
}

export interface BlastRadiusConfig {
  /** Thresholds for classification */
  catastrophicThreshold: number; // Score >= this = catastrophic
  severeThreshold: number;       // Score >= this = severe
  moderateThreshold: number;     // Score >= this = moderate
  
  /** Recovery time estimates by criticality (hours) */
  criticalRecoveryHours: number;
  highRecoveryHours: number;
  mediumRecoveryHours: number;
  lowRecoveryHours: number;
  
  /** Cache results for this many minutes */
  cacheMinutes: number;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: BlastRadiusConfig = {
  catastrophicThreshold: 75,
  severeThreshold: 50,
  moderateThreshold: 25,
  
  criticalRecoveryHours: 48,
  highRecoveryHours: 24,
  mediumRecoveryHours: 12,
  lowRecoveryHours: 4,
  
  cacheMinutes: 15,
};

const BLAST_RADIUS_DISCLAIMER = "Blast radius metrics are for operational planning and incident response. They do not expose security-sensitive information or internal credentials.";

const cache = new NodeCache({
  stdTTL: DEFAULT_CONFIG.cacheMinutes * 60,
  checkperiod: 60,
  useClones: false,
});

// ── Blast Radius Analyzer ───────────────────────────────────────────────

export class BlastRadiusAnalyzer {
  private config: BlastRadiusConfig;
  private dependencyGraph: DependencyGraph;

  constructor(config: Partial<BlastRadiusConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dependencyGraph = { nodes: [], edges: [] };
  }

  /**
   * Load dependency graph
   */
  loadDependencyGraph(graph: DependencyGraph): void {
    this.dependencyGraph = graph;
    cache.flushAll();
  }

  /**
   * Analyze blast radius for a dependency failure
   */
  async analyzeBlastRadius(dependencyId: string): Promise<BlastRadiusResult> {
    const cacheKey = `blast_radius:${dependencyId}`;
    const cached = cache.get<BlastRadiusResult>(cacheKey);
    
    if (cached) {
      return cached;
    }

    if (freezeService.isFrozen()) {
      throw new Error("Blast radius analyzer is frozen");
    }

    const dependency = this.dependencyGraph.nodes.find(n => n.id === dependencyId);
    if (!dependency) {
      throw new Error(`Dependency ${dependencyId} not found in graph`);
    }

    try {
      // Find all affected entities through graph traversal
      const affectedEntities = this.findAffectedEntities(dependencyId);
      
      // Calculate blast radius score
      const blastRadiusScore = this.calculateBlastRadiusScore(affectedEntities, dependency);
      
      // Classify the blast radius
      const classification = this.classifyBlastRadius(blastRadiusScore);
      
      // Calculate cascade depth
      const cascadeDepth = this.calculateCascadeDepth(dependencyId);
      
      // Estimate recovery time
      const estimatedRecoveryHours = this.estimateRecoveryTime(dependency, affectedEntities);
      
      // Generate recommended actions
      const recommendedActions = this.generateRecommendedActions(dependency, affectedEntities, classification);

      const result: BlastRadiusResult = {
        failedDependency: dependency,
        totalAffected: affectedEntities.length,
        affectedEntities,
        blastRadiusScore: Math.round(blastRadiusScore * 100) / 100,
        classification,
        cascadeDepth,
        estimatedRecoveryHours,
        recommendedActions,
        analyzedAt: new Date().toISOString(),
        disclaimer: BLAST_RADIUS_DISCLAIMER,
      };

      cache.set(cacheKey, result);
      
      return result;
    } catch (error) {
      console.error(`Failed to analyze blast radius for ${dependencyId}:`, error);
      throw error;
    }
  }

  /**
   * Analyze blast radius for multiple dependencies
   */
  async batchAnalyze(dependencyIds: string[]): Promise<BlastRadiusResult[]> {
    const promises = dependencyIds.map(id => this.analyzeBlastRadius(id));
    return Promise.all(promises);
  }

  /**
   * Get all dependencies that could affect a specific entity
   */
  getDependenciesForEntity(entityId: string): Dependency[] {
    const affectedEdges = this.dependencyGraph.edges.filter(
      edge => this.isEdgeAffectingEntity(edge, entityId),
    );
    
    const dependencyIds = new Set(affectedEdges.map(e => e.to));
    return this.dependencyGraph.nodes.filter(n => dependencyIds.has(n.id));
  }

  /**
   * Get critical dependencies (those with highest blast radius)
   */
  async getCriticalDependencies(topN: number = 10): Promise<Array<{
    dependency: Dependency;
    blastRadiusScore: number;
  }>> {
    const results = await this.batchAnalyze(
      this.dependencyGraph.nodes.map(n => n.id),
    );
    
    return results
      .map(r => ({
        dependency: r.failedDependency,
        blastRadiusScore: r.blastRadiusScore,
      }))
      .sort((a, b) => b.blastRadiusScore - a.blastRadiusScore)
      .slice(0, topN);
  }

  /**
   * Get current dependency graph
   */
  getDependencyGraph(): DependencyGraph {
    return { ...this.dependencyGraph };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<BlastRadiusConfig>): void {
    this.config = { ...this.config, ...newConfig };
    cache.flushAll();
  }

  /**
   * Get current configuration
   */
  getConfig(): BlastRadiusConfig {
    return { ...this.config };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    cache.flushAll();
  }

  // ── Private Methods ───────────────────────────────────────────────────

  /**
   * Find all entities affected by a dependency failure
   */
  private findAffectedEntities(dependencyId: string): AffectedEntity[] {
    const affected: AffectedEntity[] = [];
    const visited = new Set<string>();
    const queue: string[] = [dependencyId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      // Find all edges where current dependency is the target
      const incomingEdges = this.dependencyGraph.edges.filter(
        edge => edge.to === currentId,
      );

      for (const edge of incomingEdges) {
        const sourceNode = this.dependencyGraph.nodes.find(n => n.id === edge.from);
        if (!sourceNode) continue;

        // If this is an entity (strategy, vault, etc.), add to affected list
        if (this.isEntityType(sourceNode.type)) {
          const impactPercentage = this.calculateImpactPercentage(edge, visited);
          const impactSeverity = this.determineImpactSeverity(impactPercentage);
          
          affected.push({
            entityId: sourceNode.id,
            entityType: this.mapToEntityType(sourceNode.type),
            entityName: sourceNode.name,
            impactSeverity,
            impactPercentage: Math.round(impactPercentage * 100) / 100,
            impactDescription: this.generateImpactDescription(sourceNode, dependencyId, impactSeverity),
          });
        }

        // Continue traversal
        if (!visited.has(edge.from)) {
          queue.push(edge.from);
        }
      }
    }

    return affected;
  }

  /**
   * Calculate blast radius score (0-100)
   */
  private calculateBlastRadiusScore(
    affectedEntities: AffectedEntity[],
    dependency: Dependency,
  ): number {
    if (affectedEntities.length === 0) return 0;

    // Base score from number of affected entities
    const entityCountScore = Math.min(affectedEntities.length * 5, 40);
    
    // Score from severity distribution
    const criticalCount = affectedEntities.filter(e => e.impactSeverity === "critical").length;
    const highCount = affectedEntities.filter(e => e.impactSeverity === "high").length;
    const severityScore = (criticalCount * 15) + (highCount * 8);
    
    // Score from average impact percentage
    const avgImpact = affectedEntities.reduce((sum, e) => sum + e.impactPercentage, 0) / affectedEntities.length;
    const impactScore = avgImpact * 0.3;
    
    // Dependency criticality multiplier
    const criticalityMultiplier = this.getCriticalityMultiplier(dependency.criticality);
    
    const rawScore = (entityCountScore + severityScore + impactScore) * criticalityMultiplier;
    
    return Math.min(100, rawScore);
  }

  /**
   * Classify blast radius based on score
   */
  private classifyBlastRadius(score: number): BlastRadiusResult["classification"] {
    if (score >= this.config.catastrophicThreshold) return "catastrophic";
    if (score >= this.config.severeThreshold) return "severe";
    if (score >= this.config.moderateThreshold) return "moderate";
    return "minimal";
  }

  /**
   * Calculate cascade depth (max hops from failed dependency)
   */
  private calculateCascadeDepth(dependencyId: string): number {
    const visited = new Set<string>();
    let depth = 0;
    let currentLevel = [dependencyId];

    while (currentLevel.length > 0) {
      const nextLevel: string[] = [];
      
      for (const nodeId of currentLevel) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const incomingEdges = this.dependencyGraph.edges.filter(
          edge => edge.to === nodeId,
        );
        
        for (const edge of incomingEdges) {
          if (!visited.has(edge.from)) {
            nextLevel.push(edge.from);
          }
        }
      }
      
      if (nextLevel.length > 0) {
        depth++;
      }
      
      currentLevel = nextLevel;
    }

    return depth;
  }

  /**
   * Estimate recovery time based on dependency and impact
   */
  private estimateRecoveryTime(
    dependency: Dependency,
    affectedEntities: AffectedEntity[],
  ): number {
    // Base recovery time from dependency criticality
    let baseTime: number;
    switch (dependency.criticality) {
      case "critical":
        baseTime = this.config.criticalRecoveryHours;
        break;
      case "high":
        baseTime = this.config.highRecoveryHours;
        break;
      case "medium":
        baseTime = this.config.mediumRecoveryHours;
        break;
      case "low":
        baseTime = this.config.lowRecoveryHours;
        break;
    }

    // Adjust based on number of affected entities
    const entityMultiplier = 1 + (affectedEntities.length * 0.1);
    
    return Math.round(baseTime * entityMultiplier);
  }

  /**
   * Generate recommended actions for incident response
   */
  private generateRecommendedActions(
    dependency: Dependency,
    affectedEntities: AffectedEntity[],
    classification: BlastRadiusResult["classification"],
  ): string[] {
    const actions: string[] = [];

    // Immediate actions based on classification
    if (classification === "catastrophic") {
      actions.push("🚨 Initiate emergency response protocol");
      actions.push("Alert all stakeholders and incident response team");
      actions.push("Activate failover systems if available");
    } else if (classification === "severe") {
      actions.push("⚠️ Notify incident response team immediately");
      actions.push("Assess failover options for critical affected entities");
    } else if (classification === "moderate") {
      actions.push("Monitor affected entities closely");
      actions.push("Prepare contingency plans");
    }

    // Dependency-specific actions
    actions.push(`Investigate root cause of ${dependency.name} failure`);
    
    // Entity-specific actions
    const criticalEntities = affectedEntities.filter(e => e.impactSeverity === "critical");
    if (criticalEntities.length > 0) {
      actions.push(`Prioritize recovery for ${criticalEntities.length} critical entity/entities`);
    }

    // Post-incident actions
    actions.push("Document incident timeline and impact");
    actions.push("Review and update dependency redundancy plans");

    return actions;
  }

  /**
   * Calculate impact percentage for an entity
   */
  private calculateImpactPercentage(edge: DependencyEdge, visited: Set<string>): number {
    // Base impact from edge weight
    let impact = edge.impactWeight * 100;
    
    // Reduce impact for deeper cascades
    const depthPenalty = visited.size * 0.05;
    impact = impact * (1 - depthPenalty);
    
    return Math.max(0, Math.min(100, impact));
  }

  /**
   * Determine impact severity from percentage
   */
  private determineImpactSeverity(percentage: number): AffectedEntity["impactSeverity"] {
    if (percentage >= 80) return "critical";
    if (percentage >= 60) return "high";
    if (percentage >= 40) return "medium";
    return "low";
  }

  /**
   * Generate human-readable impact description
   */
  private generateImpactDescription(
    entity: Dependency,
    failedDependencyId: string,
    severity: AffectedEntity["impactSeverity"],
  ): string {
    return `${entity.name} ${severity === "critical" ? "critically depends on" : "is affected by"} the failure of ${failedDependencyId}`;
  }

  /**
   * Get criticality multiplier for score calculation
   */
  private getCriticalityMultiplier(criticality: Dependency["criticality"]): number {
    switch (criticality) {
      case "critical": return 1.5;
      case "high": return 1.2;
      case "medium": return 1.0;
      case "low": return 0.7;
    }
  }

  /**
   * Check if dependency type represents an entity
   */
  private isEntityType(type: DependencyType): boolean {
    return type === "smart_contract" || type === "infrastructure";
  }

  /**
   * Map dependency type to entity type
   */
  private mapToEntityType(type: DependencyType): AffectedEntity["entityType"] {
    if (type === "smart_contract") return "strategy";
    return "service";
  }

  /**
   * Check if edge affects a specific entity
   */
  private isEdgeAffectingEntity(edge: DependencyEdge, entityId: string): boolean {
    return edge.from === entityId || edge.to === entityId;
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const blastRadiusAnalyzer = new BlastRadiusAnalyzer();

// ── Helper Functions ─────────────────────────────────────────────────────

/**
 * Format blast radius result for API response
 */
export function formatBlastRadiusResult(result: BlastRadiusResult): BlastRadiusResult {
  return {
    ...result,
    blastRadiusScore: Math.round(result.blastRadiusScore * 100) / 100,
    affectedEntities: result.affectedEntities.map(entity => ({
      ...entity,
      impactPercentage: Math.round(entity.impactPercentage * 100) / 100,
    })),
  };
}

/**
 * Get blast radius summary for UI display
 */
export function getBlastRadiusSummary(result: BlastRadiusResult): {
  verdict: string;
  color: string;
  message: string;
} {
  const { classification, totalAffected, blastRadiusScore } = result;
  
  switch (classification) {
    case "catastrophic":
      return {
        verdict: "Catastrophic Impact",
        color: "red",
        message: `Failure affects ${totalAffected} entities with score ${blastRadiusScore.toFixed(1)}`,
      };
    case "severe":
      return {
        verdict: "Severe Impact",
        color: "orange",
        message: `Failure affects ${totalAffected} entities with score ${blastRadiusScore.toFixed(1)}`,
      };
    case "moderate":
      return {
        verdict: "Moderate Impact",
        color: "yellow",
        message: `Failure affects ${totalAffected} entities with score ${blastRadiusScore.toFixed(1)}`,
      };
    default:
      return {
        verdict: "Minimal Impact",
        color: "green",
        message: `Failure affects ${totalAffected} entities with score ${blastRadiusScore.toFixed(1)}`,
      };
  }
}
