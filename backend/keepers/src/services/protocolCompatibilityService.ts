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

export interface CompatibilityIssue {
    severity: 'critical' | 'warning' | 'info';
    component: string;
    message: string;
    recommendation: string;
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
