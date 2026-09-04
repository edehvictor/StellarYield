/**
 * Protocol Compatibility Service
 * Manages protocol upgrade compatibility checks and recommendations
 */

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

export const ACTION_DESCRIPTIONS: Record<ActionType, string> = {
    deposit: 'Adding funds to vaults or strategies',
    withdraw: 'Removing funds from vaults or strategies',
    rebalance: 'Reallocating capital across positions',
    quote: 'Fetching swap rates and price estimates',
    reporting: 'Aggregating yield and performance data',
};

const SEVERITY_RANK: Record<string, number> = {
    critical: 0,
    warning: 1,
    info: 2,
};

export interface CompatibilityIssue {
    severity: 'critical' | 'warning' | 'info';
    component: string;
    message: string;
    recommendation: string;
    affectedActions?: ActionType[];
    lastUpdated?: string;
    protocolName?: string;
}

export interface CompatibilityStatus {
    protocolName: string;
    currentVersion: string;
    latestVersion: string;
    status: 'compatible' | 'degraded' | 'incompatible';
    issues: CompatibilityIssue[];
    recommendations: string[];
    autoUpdateAvailable: boolean;
}

export interface CompatibilityReport {
    overallStatus: 'compatible' | 'degraded' | 'incompatible';
    protocols: CompatibilityStatus[];
    criticalIssues: CompatibilityIssue[];
    generatedAt: string;
    nextCheckDue: string;
}

export interface FallbackCandidate {
    providerId: string;
    protocolName: string;
    currentVersion: string;
    latestVersion: string;
    requirements: CompatibilityRequirement[];
    priority: number;
    parentProviderId?: string | null;
}

export type FallbackDecision = 'accepted' | 'rejected';

export interface FallbackEvaluation {
    providerId: string;
    protocolName: string;
    priority: number;
    decision: FallbackDecision;
    reason: string;
    status: 'compatible' | 'degraded' | 'incompatible';
    issues: CompatibilityIssue[];
}

export interface FallbackResolution {
    selectedProviderId: string | null;
    selectedEvaluation: FallbackEvaluation | null;
    evaluations: FallbackEvaluation[];
    rejectedEvaluations: FallbackEvaluation[];
    deterministic: true;
}

export interface ProtocolFixture {
    name: string;
    protocolName: string;
    currentVersion: string;
    latestVersion: string;
    upgradeType: 'compatible' | 'degraded' | 'incompatible';
    components: Array<{
        name: string;
        currentVersion: string;
        requiredVersion: string;
        status: 'compatible' | 'degraded' | 'incompatible';
    }>;
    expectedIssues: CompatibilityIssue[];
    expectedRecommendations: string[];
}

/**
 * Compare two semantic versions
 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;

        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }

    return 0;
}

/**
 * Check if a version satisfies a requirement
 */
export function versionSatisfiesRequirement(
    currentVersion: string,
    requirement: CompatibilityRequirement,
): boolean {
    const minOk = compareVersions(currentVersion, requirement.minVersion) >= 0;
    const maxOk = !requirement.maxVersion ||
        compareVersions(currentVersion, requirement.maxVersion) <= 0;

    return minOk && maxOk;
}

/**
 * Detect breaking changes between versions
 */
export function detectBreakingChanges(
    currentVersion: string,
    latestVersion: string,
    breakingChanges: string[],
): string[] {
    // If upgrading to a major version, assume breaking changes apply
    const currentMajor = parseInt(currentVersion.split('.')[0]);
    const latestMajor = parseInt(latestVersion.split('.')[0]);

    if (latestMajor > currentMajor) {
        return breakingChanges;
    }

    return [];
}

/**
 * Evaluate protocol compatibility status
 */
export function evaluateProtocolCompatibility(
    protocolName: string,
    currentVersion: string,
    latestVersion: string,
    requirements: CompatibilityRequirement[],
): CompatibilityStatus {
    const issues: CompatibilityIssue[] = [];
    const recommendations: string[] = [];
    let hasWarnings = false;
    let hasCritical = false;

    for (const req of requirements) {
        if (!versionSatisfiesRequirement(currentVersion, req)) {
            hasCritical = true;
            issues.push({
                severity: 'critical',
                component: req.component,
                message: `Component ${req.component} version ${currentVersion} does not meet requirement ${req.requiredVersion}`,
                recommendation: `Upgrade ${req.component} to at least ${req.requiredVersion}`,
            });
            recommendations.push(
                `Upgrade ${req.component} to ${req.requiredVersion}`,
            );
        }

        const breaking = detectBreakingChanges(
            currentVersion,
            latestVersion,
            req.breakingChanges,
        );

        if (breaking.length > 0) {
            hasWarnings = true;
            issues.push({
                severity: 'warning',
                component: req.component,
                message: `Breaking changes detected: ${breaking.join(', ')}`,
                recommendation: `Review and test ${breaking.join(', ')} before upgrading`,
            });
        }
    }

    let status: 'compatible' | 'degraded' | 'incompatible' = 'compatible';
    if (hasCritical) {
        status = 'incompatible';
    } else if (hasWarnings) {
        status = 'degraded';
    }

    return {
        protocolName,
        currentVersion,
        latestVersion,
        status,
        issues,
        recommendations,
        autoUpdateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    };
}

/**
 * Generate compatibility report for multiple protocols
 */
export function generateCompatibilityReport(
    protocols: Array<{
        name: string;
        currentVersion: string;
        latestVersion: string;
        requirements: CompatibilityRequirement[];
    }>,
): CompatibilityReport {
    const statuses = protocols.map(p =>
        evaluateProtocolCompatibility(
            p.name,
            p.currentVersion,
            p.latestVersion,
            p.requirements,
        ),
    );

    const criticalIssues = statuses
        .flatMap(s => s.issues)
        .filter(i => i.severity === 'critical');

    let overallStatus: 'compatible' | 'degraded' | 'incompatible' = 'compatible';
    if (criticalIssues.length > 0) {
        overallStatus = 'incompatible';
    } else if (statuses.some(s => s.status === 'degraded')) {
        overallStatus = 'degraded';
    }

    return {
        overallStatus,
        protocols: statuses,
        criticalIssues,
        generatedAt: new Date().toISOString(),
        nextCheckDue: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
}

export interface ActionGroup {
    action: ActionType;
    label: string;
    description: string;
    issues: CompatibilityIssue[];
    status: 'clear' | 'warning' | 'degraded' | 'blocked';
}

const ALL_ACTIONS: ActionType[] = ['deposit', 'withdraw', 'rebalance', 'quote', 'reporting'];

/**
 * Derive aggregate status for an action group from its issues
 */
function actionGroupStatus(issues: CompatibilityIssue[]): ActionGroup['status'] {
    if (issues.length === 0) return 'clear';
    if (issues.some(i => i.severity === 'critical')) return 'blocked';
    if (issues.some(i => i.severity === 'warning')) return 'degraded';
    return 'warning';
}

/**
 * Group issues by the actions they affect.
 * Issues with no affectedActions are placed into every group so they
 * are surfaced regardless of the selected action tab.
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

    return ALL_ACTIONS.map(action => ({
        action,
        label: ACTION_LABELS[action],
        description: ACTION_DESCRIPTIONS[action],
        issues: sortIssues(grouped[action]),
        status: actionGroupStatus(grouped[action]),
    }));
}

/**
 * Sort compatibility issues by severity (critical first) then by
 * lastUpdated (most recent first).  Issues without a date sort last.
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

/**
 * Resolve a fallback tree after a primary protocol compatibility failure.
 *
 * Candidates are visited in deterministic depth-first order. Sibling
 * fallbacks are ordered by priority and then providerId, so repeated runs
 * always produce the same decision. The first compatible or degraded
 * candidate is selected; incompatible candidates are recorded with the
 * critical issues that caused them to be rejected.
 */
export function resolveFallbackTree(
    primary: FallbackCandidate,
    fallbacks: FallbackCandidate[] = [],
): FallbackResolution {
    const byParent = new Map<string | null, FallbackCandidate[]>();

    const addCandidate = (candidate: FallbackCandidate, parentKey: string | null): void => {
        const siblings = byParent.get(parentKey) ?? [];
        siblings.push(candidate);
        byParent.set(parentKey, siblings);
    };

    addCandidate(primary, null);
    const knownProviderIds = new Set<string>([
        primary.providerId,
        ...fallbacks.map(fallback => fallback.providerId),
    ]);
    for (const fallback of fallbacks) {
        const parentKey = fallback.parentProviderId != null &&
            fallback.parentProviderId !== fallback.providerId &&
            knownProviderIds.has(fallback.parentProviderId)
            ? fallback.parentProviderId
            : primary.providerId;
        addCandidate(fallback, parentKey);
    }

    for (const siblings of byParent.values()) {
        siblings.sort((a, b) =>
            a.priority - b.priority ||
            (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0),
        );
    }

    const ordered: FallbackCandidate[] = [];
    const visited = new Set<string>();

    const visit = (candidate: FallbackCandidate): void => {
        if (visited.has(candidate.providerId)) return;
        visited.add(candidate.providerId);
        ordered.push(candidate);

        const children = byParent.get(candidate.providerId) ?? [];
        for (const child of children) {
            visit(child);
        }
    };

    visit(primary);

    const unvisited = fallbacks
        .filter(fallback => !visited.has(fallback.providerId))
        .sort((a, b) =>
            a.priority - b.priority ||
            (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0),
        );

    for (const fallback of unvisited) {
        visit(fallback);
    }

    const evaluations: FallbackEvaluation[] = [];

    for (const candidate of ordered) {
        const status = evaluateProtocolCompatibility(
            candidate.protocolName,
            candidate.currentVersion,
            candidate.latestVersion,
            candidate.requirements,
        );

        const accepted = status.status !== 'incompatible';
        let reason: string;

        if (accepted) {
            reason = `${candidate.providerId} is ${status.status}`;
        } else {
            const criticalMessages = status.issues
                .filter(issue => issue.severity === 'critical')
                .map(issue => issue.message)
                .join('; ');
            reason = criticalMessages
                ? `${candidate.providerId} is incompatible: ${criticalMessages}`
                : `${candidate.providerId} is incompatible`;
        }

        evaluations.push({
            providerId: candidate.providerId,
            protocolName: candidate.protocolName,
            priority: candidate.priority,
            decision: accepted ? 'accepted' : 'rejected',
            reason,
            status: status.status,
            issues: status.issues,
        });
    }

    const selectedEvaluation = evaluations.find(
        evaluation => evaluation.decision === 'accepted',
    ) ?? null;

    const rejectedEvaluations = evaluations.filter(
        evaluation => evaluation.decision === 'rejected',
    );

    return {
        selectedProviderId: selectedEvaluation?.providerId ?? null,
        selectedEvaluation,
        evaluations,
        rejectedEvaluations,
        deterministic: true,
    };
}

/**
 * Create a protocol fixture for testing
 */
export function createProtocolFixture(
    name: string,
    protocolName: string,
    currentVersion: string,
    latestVersion: string,
    upgradeType: 'compatible' | 'degraded' | 'incompatible',
): ProtocolFixture {
    const components = [
        {
            name: 'core_contract',
            currentVersion,
            requiredVersion: latestVersion,
            status: upgradeType,
        },
        {
            name: 'api',
            currentVersion,
            requiredVersion: latestVersion,
            status: upgradeType,
        },
    ];

    const expectedIssues: CompatibilityIssue[] = [];
    const expectedRecommendations: string[] = [];

    if (upgradeType === 'incompatible') {
        expectedIssues.push({
            severity: 'critical',
            component: 'core_contract',
            message: `Component core_contract version ${currentVersion} does not meet requirement ${latestVersion}`,
            recommendation: `Upgrade core_contract to at least ${latestVersion}`,
        });
        expectedRecommendations.push(`Upgrade core_contract to ${latestVersion}`);
    } else if (upgradeType === 'degraded') {
        expectedIssues.push({
            severity: 'warning',
            component: 'api',
            message: 'Breaking changes detected: endpoint_deprecation, response_format_change',
            recommendation: 'Review and test endpoint_deprecation, response_format_change before upgrading',
        });
    }

    return {
        name,
        protocolName,
        currentVersion,
        latestVersion,
        upgradeType,
        components,
        expectedIssues,
        expectedRecommendations,
    };
}
