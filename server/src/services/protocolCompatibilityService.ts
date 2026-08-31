import NodeCache from "node-cache";
import { freezeService } from "./freezeService";

// ── Types ───────────────────────────────────────────────────────────────

export interface ProtocolVersion {
  protocolName: string;
  version: string;
  contractAddress?: string;
  apiVersion?: string;
  lastUpdated: string;
  checksum?: string;
}

export interface CompatibilityRequirement {
  component: string;
  requiredVersion: string;
  minVersion: string;
  maxVersion?: string;
  criticalFeatures: string[];
  breakingChanges: string[];
}

export type ActionType = 'deposit' | 'withdraw' | 'rebalance' | 'quote' | 'reporting';

export const ACTION_LABELS: Record<ActionType, string> = {
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  rebalance: 'Rebalance',
  quote: 'Quote',
  reporting: 'Reporting',
};

export interface ActionGroup {
  action: ActionType;
  label: string;
  issues: CompatibilityIssue[];
  issueCount: number;
  status: 'clear' | 'warning' | 'degraded' | 'blocked';
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const ALL_ACTIONS: ActionType[] = ['deposit', 'withdraw', 'rebalance', 'quote', 'reporting'];

/**
 * Human-readable categories that explain why a provider/source was
 * downgraded.  Used to populate the `fallbackReason` field on every
 * `CompatibilityIssue` so operators can act on the actual root cause
 * instead of a generic numeric score.
 */
export type FallbackReasonCode =
  | 'version_below_minimum'
  | 'version_exceeds_maximum'
  | 'breaking_change_detected'
  | 'critical_feature_unavailable'
  | 'version_fetch_failed'
  | 'compatibility_check_failed'
  | 'unknown';

/** Mapping from code to operator-readable description. */
export const FALLBACK_REASON_LABELS: Record<FallbackReasonCode, string> = {
  version_below_minimum:       'Version below minimum — provider is running an outdated release',
  version_exceeds_maximum:     'Version exceeds maximum — provider release is ahead of supported range',
  breaking_change_detected:    'Breaking change detected — protocol update introduced incompatible changes',
  critical_feature_unavailable:'Critical feature unavailable — required capability is missing from provider',
  version_fetch_failed:        'Version fetch failed — provider version could not be retrieved',
  compatibility_check_failed:  'Compatibility check failed — automated check could not complete',
  unknown:                     'Unknown degradation reason — manual inspection required',
};

export interface CompatibilityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  component: string;
  issue: string;
  impact: string;
  recommendation: string;
  affectedStrategies: string[];
  affectedActions?: ActionType[];
  lastUpdated?: string;
  protocolName?: string;
  /** Machine-readable code identifying why the provider was downgraded. */
  fallbackReasonCode?: FallbackReasonCode;
  /** Human-readable sentence explaining the downgrade reason. */
  fallbackReason?: string;
}

/**
 * Derive a `FallbackReasonCode` and its human-readable label from the
 * context of a compatibility issue.  The function inspects the `issue`
 * text (and optionally the component) to pick the most specific code;
 * it falls back to `'unknown'` when no pattern matches.
 */
export function deriveFallbackReason(issue: string, component?: string): {
  fallbackReasonCode: FallbackReasonCode;
  fallbackReason: string;
} {
  const text = `${issue} ${component ?? ''}`.toLowerCase();

  let code: FallbackReasonCode;

  if (/below required|below minimum|version.*is below/i.test(text)) {
    code = 'version_below_minimum';
  } else if (/exceeds maximum|above maximum|version.*exceeds/i.test(text)) {
    code = 'version_exceeds_maximum';
  } else if (/breaking change/i.test(text)) {
    code = 'breaking_change_detected';
  } else if (/critical feature|features unavailable|missing feature/i.test(text)) {
    code = 'critical_feature_unavailable';
  } else if (/failed to fetch.*version|version.*fetch.*fail/i.test(text)) {
    code = 'version_fetch_failed';
  } else if (/compatibility check failed|check.*failed/i.test(text)) {
    code = 'compatibility_check_failed';
  } else {
    code = 'unknown';
  }

  return { fallbackReasonCode: code, fallbackReason: FALLBACK_REASON_LABELS[code] };
}

export interface CompatibilityStatus {
  protocolName: string;
  currentVersion: string;
  latestVersion: string;
  status: 'compatible' | 'degraded' | 'incompatible';
  issues: CompatibilityIssue[];
  lastChecked: string;
  recommendations: string[];
  autoUpdateAvailable: boolean;
}

export interface CompatibilityReport {
  overallStatus: 'compatible' | 'degraded' | 'incompatible';
  protocols: CompatibilityStatus[];
  criticalIssues: CompatibilityIssue[];
  actionGroups: ActionGroup[];
  generatedAt: string;
  nextCheckDue: string;
}

export interface CompatibilityConfig {
  checkIntervalMinutes: number;
  criticalFailureThreshold: number;
  autoDisableIncompatible: boolean;
  notifyOnDegraded: boolean;
  cacheResultsMinutes: number;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: CompatibilityConfig = {
  checkIntervalMinutes: 60,
  criticalFailureThreshold: 1,
  autoDisableIncompatible: true,
  notifyOnDegraded: true,
  cacheResultsMinutes: 30,
};

const cache = new NodeCache({
  stdTTL: DEFAULT_CONFIG.cacheResultsMinutes * 60,
  checkperiod: 60,
  useClones: false,
});

function actionGroupStatus(issues: CompatibilityIssue[]): ActionGroup['status'] {
  if (issues.length === 0) return 'clear';
  if (issues.some(i => i.severity === 'critical')) return 'blocked';
  if (issues.some(i => i.severity === 'high')) return 'degraded';
  if (issues.some(i => i.severity === 'medium')) return 'degraded';
  return 'warning';
}

/**
 * Group issues by the actions they affect.
 * Issues with no affectedActions are placed into *every* group so they
 * remain visible regardless of which action tab the operator selects.
 */
export function groupIssuesByAction(issues: CompatibilityIssue[]): ActionGroup[] {
  const grouped: Record<ActionType, CompatibilityIssue[]> = {
    deposit: [],
    withdraw: [],
    rebalance: [],
    quote: [],
    reporting: [],
  };

  for (const issue of issues) {
    const actions = (issue.affectedActions?.length ?? 0) > 0
      ? issue.affectedActions!
      : ALL_ACTIONS;

    for (const action of actions) {
      if (!grouped[action]) continue;
      grouped[action].push(issue);
    }
  }

  return ALL_ACTIONS.map(action => {
    const issues = sortIssues(grouped[action]);
    return {
      action,
      label: (ACTION_LABELS as Record<ActionType, string>)[action],
      issues,
      issueCount: issues.length,
      status: actionGroupStatus(issues),
    };
  });
}

/**
 * Sort compatibility issues by severity (critical first, then high,
 * medium, low) and by lastUpdated (most recent first).  Issues
 * without a lastUpdated date sort last within their severity tier.
 */
export function sortIssues(issues: CompatibilityIssue[]): CompatibilityIssue[] {
  return [...issues].sort((a, b) => {
    const rankA = SEVERITY_RANK[a.severity] ?? 99;
    const rankB = SEVERITY_RANK[b.severity] ?? 99;
    if (rankA !== rankB) return rankA - rankB;

    const dateA = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
    const dateB = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
    return dateB - dateA;
  });
}

// ── Compatibility Engine ────────────────────────────────────────────────

export class ProtocolCompatibilityEngine {
  private config: CompatibilityConfig;
  private requirements: Map<string, CompatibilityRequirement[]>;

  constructor(config: Partial<CompatibilityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.requirements = new Map();
    this.initializeRequirements();
  }

  /**
   * Initialize compatibility requirements for known protocols
   */
  private initializeRequirements(): void {
    // Blend Protocol Requirements
    this.requirements.set('Blend', [
      {
        component: 'core_contract',
        requiredVersion: '2.1.0',
        minVersion: '2.0.0',
        criticalFeatures: ['deposit', 'withdraw', 'get_apy'],
        breakingChanges: ['fee_structure_change', 'withdrawal_delay'],
      },
      {
        component: 'api',
        requiredVersion: 'v1.3',
        minVersion: 'v1.0',
        criticalFeatures: ['yield_data', 'vault_info'],
        breakingChanges: ['endpoint_deprecation', 'response_format_change'],
      },
    ]);

    // Soroswap Requirements
    this.requirements.set('Soroswap', [
      {
        component: 'router_contract',
        requiredVersion: '1.4.2',
        minVersion: '1.3.0',
        criticalFeatures: ['swap_exact_tokens', 'get_amount_out'],
        breakingChanges: ['fee_calculation_change', 'slippage_formula_update'],
      },
      {
        component: 'pool_contract',
        requiredVersion: '1.2.1',
        minVersion: '1.1.0',
        criticalFeatures: ['add_liquidity', 'remove_liquidity'],
        breakingChanges: ['reward_distribution_change'],
      },
    ]);

    // DeFindex Requirements
    this.requirements.set('DeFindex', [
      {
        component: 'index_contract',
        requiredVersion: '3.0.1',
        minVersion: '2.5.0',
        maxVersion: '3.1.0',
        criticalFeatures: ['mint', 'redeem', 'rebalance'],
        breakingChanges: ['index_composition_change', 'fee_structure_overhaul'],
      },
    ]);
  }

  /**
   * Run comprehensive compatibility check
   */
  async runCompatibilityCheck(): Promise<CompatibilityReport> {
    const cacheKey = 'compatibility:report';
    const cached = cache.get<CompatibilityReport>(cacheKey);
    
    if (cached) {
      return cached;
    }

    if (freezeService.isFrozen()) {
      throw new Error("Compatibility service is frozen");
    }

    try {
      const protocols = await this.checkAllProtocols();
      const criticalIssues = protocols
        .flatMap(p => p.issues)
        .filter(issue => issue.severity === 'critical');

      const overallStatus = this.determineOverallStatus(protocols, criticalIssues);

      const actionGroups = groupIssuesByAction(criticalIssues.length > 0 ? criticalIssues : protocols.flatMap(p => p.issues));

      const report: CompatibilityReport = {
        overallStatus,
        protocols,
        criticalIssues,
        actionGroups,
        generatedAt: new Date().toISOString(),
        nextCheckDue: new Date(Date.now() + this.config.checkIntervalMinutes * 60 * 1000).toISOString(),
      };

      cache.set(cacheKey, report);
      
      // Auto-disable incompatible protocols if configured
      if (this.config.autoDisableIncompatible) {
        await this.handleIncompatibleProtocols(protocols);
      }

      return report;
    } catch (error) {
      console.error("Compatibility check failed:", error);
      throw new Error(`Compatibility check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check compatibility for all known protocols
   */
  private async checkAllProtocols(): Promise<CompatibilityStatus[]> {
    const protocolNames = Array.from(this.requirements.keys());
    const checks = protocolNames.map(name => this.checkProtocol(name));
    
    return Promise.all(checks);
  }

  /**
   * Check compatibility for a specific protocol
   */
  async checkProtocol(protocolName: string): Promise<CompatibilityStatus> {
    const requirements = this.requirements.get(protocolName);
    if (!requirements) {
      throw new Error(`No compatibility requirements defined for ${protocolName}`);
    }

    try {
      // Get current and latest versions
      const currentVersion = await this.getCurrentVersion(protocolName);
      const latestVersion = await this.getLatestVersion(protocolName);

      // Check each component
      const issues: CompatibilityIssue[] = [];
      for (const requirement of requirements) {
        const componentIssues = await this.checkComponentCompatibility(protocolName, requirement.component, requirement, currentVersion);
        issues.push(...componentIssues);
      }

      const now = new Date().toISOString();

      // Annotate every issue with affectedActions and lastUpdated
      const annotated = issues.map(issue => ({
        ...issue,
        protocolName,
        lastUpdated: now,
        affectedActions: this.mapComponentToActions(issue.component),
      }));

      // Determine status
      const status = this.determineProtocolStatus(annotated);
      const recommendations = this.generateRecommendations(annotated, status);
      const autoUpdateAvailable = await this.checkAutoUpdateAvailable(protocolName, currentVersion, latestVersion);

      return {
        protocolName,
        currentVersion: currentVersion.version,
        latestVersion: latestVersion.version,
        status,
        issues: annotated,
        lastChecked: now,
        recommendations,
        autoUpdateAvailable,
      };
    } catch (error) {
      console.error('Failed to fetch protocol version:', { protocolName });
      const { fallbackReasonCode, fallbackReason } = deriveFallbackReason('Failed to fetch protocol version');
      return {
        protocolName,
        currentVersion: 'unknown',
        latestVersion: 'unknown',
        status: 'incompatible' as const,
        issues: [{
          severity: 'critical' as const,
          component: 'unknown',
          issue: 'Failed to fetch protocol version',
          impact: 'Cannot determine compatibility',
          recommendation: 'Check protocol connectivity',
          affectedStrategies: [],
          protocolName,
          lastUpdated: new Date().toISOString(),
          fallbackReasonCode,
          fallbackReason,
        }],
        lastChecked: new Date().toISOString(),
        recommendations: ['Check protocol connectivity'],
        autoUpdateAvailable: false,
      };
    }
  }

  /**
   * Check a specific compatibility requirement
   */
  private async checkComponentCompatibility(
    protocolName: string,
    componentName: string,
    requirements: CompatibilityRequirement,
    currentVersion: ProtocolVersion,
  ): Promise<CompatibilityIssue[]> {
    const issues: CompatibilityIssue[] = [];

    try {
      // Version compatibility check
      const versionCheck = this.checkVersionCompatibility(requirements, currentVersion);
      if (!versionCheck.compatible) {
        const { fallbackReasonCode, fallbackReason } = deriveFallbackReason(versionCheck.reason, requirements.component);
        issues.push({
          severity: versionCheck.isBreaking ? 'critical' : 'high',
          component: requirements.component,
          issue: versionCheck.reason,
          impact: `Component ${requirements.component} may not function correctly`,
          recommendation: `Update ${requirements.component} to compatible version`,
          affectedStrategies: await this.getAffectedStrategies(protocolName, requirements.component),
          fallbackReasonCode,
          fallbackReason,
        });
      }

      // Critical features check
      const featuresCheck = await this.checkCriticalFeatures(protocolName, requirements, currentVersion);
      if (!featuresCheck.available) {
        const { fallbackReasonCode, fallbackReason } = deriveFallbackReason('Critical features unavailable', requirements.component);
        issues.push({
          severity: 'critical',
          component: requirements.component,
          issue: 'Critical features unavailable',
          impact: featuresCheck.missingFeatures.join(', ') + ' are not available',
          recommendation: 'Upgrade protocol or use alternative implementation',
          affectedStrategies: await this.getAffectedStrategies(protocolName, requirements.component),
          fallbackReasonCode,
          fallbackReason,
        });
      }

      // Breaking changes check
      const breakingChangesCheck = await this.checkBreakingChanges(protocolName, currentVersion.version, requirements);
      if (breakingChangesCheck.hasBreakingChanges) {
        const { fallbackReasonCode, fallbackReason } = deriveFallbackReason('Breaking changes detected', requirements.component);
        issues.push({
          severity: breakingChangesCheck.affectsCriticalPath ? 'critical' : 'high',
          component: requirements.component,
          issue: 'Breaking changes detected',
          impact: breakingChangesCheck.changes.join(', '),
          recommendation: 'Review and update integration code',
          affectedStrategies: await this.getAffectedStrategies(protocolName, requirements.component),
          fallbackReasonCode,
          fallbackReason,
        });
      }

    } catch (error) {
      const { fallbackReasonCode, fallbackReason } = deriveFallbackReason('Compatibility check failed', requirements.component);
      issues.push({
        severity: 'medium',
        component: requirements.component,
        issue: 'Compatibility check failed',
        impact: `Unable to verify component compatibility: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recommendation: 'Manual verification required',
        affectedStrategies: [],
        fallbackReasonCode,
        fallbackReason,
      });
    }

    return issues;
  }

  /**
   * Check if versions are compatible
   */
  private checkVersionCompatibility(
    requirement: CompatibilityRequirement,
    currentVersion: ProtocolVersion,
  ): { compatible: boolean; isBreaking: boolean; reason: string } {
    const current = currentVersion.version;
    const required = requirement.requiredVersion;
    const min = requirement.minVersion;
    const max = requirement.maxVersion;

    // Simple version comparison (in production, use semver library)
    const isCompatible = this.compareVersions(current, min) >= 0 && 
                        (!max || this.compareVersions(current, max) <= 0);

    const isBreaking = this.compareVersions(current, required) < 0;

    return {
      compatible: isCompatible,
      isBreaking,
      reason: isCompatible ? 'Versions compatible' : 
               isBreaking ? `Version ${current} is below required ${required}` :
               `Version ${current} exceeds maximum ${max}`,
    };
  }

  /**
   * Simple version comparison (replace with semver in production)
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;
      
      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }
    
    return 0;
  }

  /**
   * Check if critical features are available
   */
  private async checkCriticalFeatures(
    protocolName: string,
    requirement: CompatibilityRequirement,
    _currentVersion: ProtocolVersion,
  ): Promise<{ available: boolean; missingFeatures: string[] }> {
    // Mock implementation - in reality, this would test the actual protocol
    const mockAvailableFeatures = ['deposit', 'withdraw', 'get_apy', 'swap_exact_tokens'];
    const missingFeatures = requirement.criticalFeatures.filter(
      feature => !mockAvailableFeatures.includes(feature)
    );

    return {
      available: missingFeatures.length === 0,
      missingFeatures,
    };
  }

  /**
   * Check for breaking changes
   */
  private async checkBreakingChanges(
    protocolName: string,
    _currentVersion: string,
    requirement: CompatibilityRequirement,
  ): Promise<{ hasBreakingChanges: boolean; affectsCriticalPath: boolean; changes: string[] }> {
    // Mock implementation - in reality, this would analyze changelogs or contract diffs
    const mockBreakingChanges = ['fee_structure_change'];
    const changes = requirement.breakingChanges.filter(change => mockBreakingChanges.includes(change));
    
    return {
      hasBreakingChanges: changes.length > 0,
      affectsCriticalPath: changes.includes('fee_structure_change'),
      changes,
    };
  }

  /**
   * Get strategies affected by a component
   */
  private async getAffectedStrategies(protocolName: string, _component: string): Promise<string[]> {
    // Mock implementation - would query strategy registry
    return [
      `${protocolName}_yield_strategy`,
      `${protocolName}_arbitrage_strategy`,
      `${protocolName}_liquidity_strategy`,
    ];
  }

  /**
   * Determine overall protocol status
   */
  private determineProtocolStatus(issues: CompatibilityIssue[]): 'compatible' | 'degraded' | 'incompatible' {
    const hasCritical = issues.some(issue => issue.severity === 'critical');
    const hasHigh = issues.some(issue => issue.severity === 'high');
    
    if (hasCritical) return 'incompatible';
    if (hasHigh) return 'degraded';
    return 'compatible';
  }

  /**
   * Determine overall system status
   */
  private determineOverallStatus(
    protocols: CompatibilityStatus[],
    criticalIssues: CompatibilityIssue[],
  ): 'compatible' | 'degraded' | 'incompatible' {
    if (criticalIssues.length >= this.config.criticalFailureThreshold) return 'incompatible';
    
    const hasIncompatible = protocols.some(p => p.status === 'incompatible');
    const hasDegraded = protocols.some(p => p.status === 'degraded');
    
    if (hasIncompatible) return 'incompatible';
    if (hasDegraded) return 'degraded';
    return 'compatible';
  }

  /**
   * Generate recommendations based on issues
   */
  private generateRecommendations(
    issues: CompatibilityIssue[],
    status: 'compatible' | 'degraded' | 'incompatible',
  ): string[] {
    const recommendations = new Set<string>();
    
    issues.forEach(issue => {
      recommendations.add(issue.recommendation);
    });

    if (status === 'incompatible') {
      recommendations.add('Consider disabling automated strategies for this protocol');
      recommendations.add('Schedule immediate maintenance window');
    } else if (status === 'degraded') {
      recommendations.add('Monitor strategy performance closely');
      recommendations.add('Plan upgrade at next opportunity');
    }

    return Array.from(recommendations);
  }

  /**
   * Get current version of a protocol
   */
  private async getCurrentVersion(protocolName: string): Promise<ProtocolVersion> {
    // Mock implementation - would query actual protocol
    return {
      protocolName,
      version: '2.1.0',
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get latest version of a protocol
   */
  private async getLatestVersion(protocolName: string): Promise<ProtocolVersion> {
    // Mock implementation - would query version registry
    return {
      protocolName,
      version: '2.2.0',
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Check if auto-update is available
   */
  private async checkAutoUpdateAvailable(
    protocolName: string,
    currentVersion: ProtocolVersion,
    latestVersion: ProtocolVersion,
  ): Promise<boolean> {
    // Mock implementation - would check update mechanisms
    return this.compareVersions(currentVersion.version, latestVersion.version) < 0;
  }

  /**
   * Map a component name to the actions it affects.
   */
  private mapComponentToActions(component: string): ActionType[] {
    const componentLower = component.toLowerCase();
    const actions: ActionType[] = [];
    if (/deposit|mint|add_liquidity/i.test(componentLower)) actions.push('deposit');
    if (/withdraw|redeem|remove_liquidity/i.test(componentLower)) actions.push('withdraw');
    if (/rebalance|swap|router|pool/i.test(componentLower)) actions.push('rebalance');
    if (/quote|get_amount_out|swap_exact/i.test(componentLower)) actions.push('quote');
    if (/api|yield|vault_info|report|index/i.test(componentLower)) actions.push('reporting');
    if (/core_contract|core/i.test(componentLower)) actions.push('deposit', 'withdraw', 'rebalance');
    return actions;
  }

  /**
   * Handle incompatible protocols
   */
  private async handleIncompatibleProtocols(protocols: CompatibilityStatus[]): Promise<void> {
    const incompatible = protocols.filter(p => p.status === 'incompatible');
    
    for (const protocol of incompatible) {
      console.warn(`Auto-disabling incompatible protocol: ${protocol.protocolName}`);
      // In reality, this would call strategy management service
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CompatibilityConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): CompatibilityConfig {
    return { ...this.config };
  }

  /**
   * Add protocol requirements
   */
  addProtocolRequirements(protocolName: string, requirements: CompatibilityRequirement[]): void {
    this.requirements.set(protocolName, requirements);
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    cache.flushAll();
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const protocolCompatibilityEngine = new ProtocolCompatibilityEngine();

// ── Helper functions ─────────────────────────────────────────────────────

/**
 * Format compatibility report for API response
 */
export function formatCompatibilityReport(report: CompatibilityReport): CompatibilityReport {
  return {
    ...report,
    protocols: report.protocols.map(protocol => ({
      ...protocol,
      issues: protocol.issues.map(issue => ({
        ...issue,
        affectedStrategies: [...issue.affectedStrategies],
      })),
    })),
    criticalIssues: report.criticalIssues.map(issue => ({
      ...issue,
      affectedStrategies: [...issue.affectedStrategies],
    })),
    actionGroups: report.actionGroups.map(group => ({
      ...group,
      issues: group.issues.map(issue => ({
        ...issue,
        affectedStrategies: [...issue.affectedStrategies],
      })),
    })),
  };
}

/**
 * Check if protocol is safe for strategy execution
 */
export function isProtocolSafeForExecution(
  protocolName: string,
  report: CompatibilityReport,
): boolean {
  const protocol = report.protocols.find(p => p.protocolName === protocolName);
  
  if (!protocol) return false;
  
  return protocol.status === 'compatible' && 
         protocol.issues.filter(i => i.severity === 'critical').length === 0;
}
