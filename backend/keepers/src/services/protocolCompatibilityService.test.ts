import { describe, it, expect } from '@jest/globals';
import {
    compareVersions,
    versionSatisfiesRequirement,
    detectBreakingChanges,
    evaluateProtocolCompatibility,
    generateCompatibilityReport,
    createProtocolFixture,
    type CompatibilityRequirement,
} from './protocolCompatibilityService';

describe('protocolCompatibilityService', () => {
    describe('compareVersions', () => {
        it('returns -1 when v1 < v2', () => {
            expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
            expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
            expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
        });

        it('returns 0 when versions are equal', () => {
            expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
            expect(compareVersions('2.5.3', '2.5.3')).toBe(0);
        });

        it('returns 1 when v1 > v2', () => {
            expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
            expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
            expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
        });
    });

    describe('versionSatisfiesRequirement', () => {
        it('returns true when version meets minimum requirement', () => {
            const req: CompatibilityRequirement = {
                component: 'core',
                requiredVersion: '2.0.0',
                minVersion: '1.5.0',
                criticalFeatures: [],
                breakingChanges: [],
            };

            expect(versionSatisfiesRequirement('2.0.0', req)).toBe(true);
            expect(versionSatisfiesRequirement('2.1.0', req)).toBe(true);
        });

        it('returns false when version is below minimum', () => {
            const req: CompatibilityRequirement = {
                component: 'core',
                requiredVersion: '2.0.0',
                minVersion: '1.5.0',
                criticalFeatures: [],
                breakingChanges: [],
            };

            expect(versionSatisfiesRequirement('1.4.0', req)).toBe(false);
        });

        it('respects maximum version constraint', () => {
            const req: CompatibilityRequirement = {
                component: 'core',
                requiredVersion: '2.0.0',
                minVersion: '1.5.0',
                maxVersion: '2.5.0',
                criticalFeatures: [],
                breakingChanges: [],
            };

            expect(versionSatisfiesRequirement('2.0.0', req)).toBe(true);
            expect(versionSatisfiesRequirement('2.5.0', req)).toBe(true);
            expect(versionSatisfiesRequirement('2.6.0', req)).toBe(false);
        });
    });

    describe('detectBreakingChanges', () => {
        it('returns breaking changes for major version upgrade', () => {
            const breaking = ['fee_structure_change', 'withdrawal_delay'];
            const detected = detectBreakingChanges('1.0.0', '2.0.0', breaking);

            expect(detected).toEqual(breaking);
        });

        it('returns empty array for minor version upgrade', () => {
            const breaking = ['fee_structure_change', 'withdrawal_delay'];
            const detected = detectBreakingChanges('1.0.0', '1.1.0', breaking);

            expect(detected).toEqual([]);
        });

        it('returns empty array for patch version upgrade', () => {
            const breaking = ['fee_structure_change', 'withdrawal_delay'];
            const detected = detectBreakingChanges('1.0.0', '1.0.1', breaking);

            expect(detected).toEqual([]);
        });
    });

    describe('evaluateProtocolCompatibility', () => {
        it('returns compatible status when all requirements met', () => {
            const requirements: CompatibilityRequirement[] = [
                {
                    component: 'core',
                    requiredVersion: '2.0.0',
                    minVersion: '1.5.0',
                    criticalFeatures: ['deposit', 'withdraw'],
                    breakingChanges: [],
                },
            ];

            const status = evaluateProtocolCompatibility(
                'Blend',
                '2.0.0',
                '2.0.0',
                requirements,
            );

            expect(status.status).toBe('compatible');
            expect(status.issues).toHaveLength(0);
        });

        it('returns incompatible status when version requirement not met', () => {
            const requirements: CompatibilityRequirement[] = [
                {
                    component: 'core',
                    requiredVersion: '2.0.0',
                    minVersion: '2.0.0',
                    criticalFeatures: ['deposit', 'withdraw'],
                    breakingChanges: [],
                },
            ];

            const status = evaluateProtocolCompatibility(
                'Blend',
                '1.5.0',
                '2.0.0',
                requirements,
            );

            expect(status.status).toBe('incompatible');
            expect(status.issues).toHaveLength(1);
            expect(status.issues[0].severity).toBe('critical');
        });

        it('returns degraded status when breaking changes detected', () => {
            const requirements: CompatibilityRequirement[] = [
                {
                    component: 'core',
                    requiredVersion: '2.0.0',
                    minVersion: '1.5.0',
                    criticalFeatures: ['deposit', 'withdraw'],
                    breakingChanges: ['fee_structure_change'],
                },
            ];

            const status = evaluateProtocolCompatibility(
                'Blend',
                '1.5.0',
                '2.0.0',
                requirements,
            );

            expect(status.status).toBe('degraded');
            expect(status.issues.some(i => i.severity === 'warning')).toBe(true);
        });

        it('includes recommendations for upgrades', () => {
            const requirements: CompatibilityRequirement[] = [
                {
                    component: 'core',
                    requiredVersion: '2.0.0',
                    minVersion: '2.0.0',
                    criticalFeatures: ['deposit', 'withdraw'],
                    breakingChanges: [],
                },
            ];

            const status = evaluateProtocolCompatibility(
                'Blend',
                '1.5.0',
                '2.0.0',
                requirements,
            );

            expect(status.recommendations).toContain('Upgrade core to 2.0.0');
        });

        it('sets autoUpdateAvailable when newer version exists', () => {
            const requirements: CompatibilityRequirement[] = [];

            const status = evaluateProtocolCompatibility(
                'Blend',
                '1.0.0',
                '2.0.0',
                requirements,
            );

            expect(status.autoUpdateAvailable).toBe(true);
        });
    });

    describe('generateCompatibilityReport', () => {
        it('generates report for multiple protocols', () => {
            const protocols = [
                {
                    name: 'Blend',
                    currentVersion: '2.0.0',
                    latestVersion: '2.0.0',
                    requirements: [
                        {
                            component: 'core',
                            requiredVersion: '2.0.0',
                            minVersion: '1.5.0',
                            criticalFeatures: [],
                            breakingChanges: [],
                        },
                    ],
                },
                {
                    name: 'Soroswap',
                    currentVersion: '1.3.0',
                    latestVersion: '1.4.0',
                    requirements: [
                        {
                            component: 'router',
                            requiredVersion: '1.4.0',
                            minVersion: '1.3.0',
                            criticalFeatures: [],
                            breakingChanges: [],
                        },
                    ],
                },
            ];

            const report = generateCompatibilityReport(protocols);

            expect(report.protocols).toHaveLength(2);
            expect(report.generatedAt).toBeDefined();
            expect(report.nextCheckDue).toBeDefined();
        });

        it('sets overall status to incompatible when critical issues exist', () => {
            const protocols = [
                {
                    name: 'Blend',
                    currentVersion: '1.0.0',
                    latestVersion: '2.0.0',
                    requirements: [
                        {
                            component: 'core',
                            requiredVersion: '2.0.0',
                            minVersion: '2.0.0',
                            criticalFeatures: [],
                            breakingChanges: [],
                        },
                    ],
                },
            ];

            const report = generateCompatibilityReport(protocols);

            expect(report.overallStatus).toBe('incompatible');
            expect(report.criticalIssues.length).toBeGreaterThan(0);
        });

        it('sets overall status to degraded when only warnings exist', () => {
            const protocols = [
                {
                    name: 'Blend',
                    currentVersion: '1.5.0',
                    latestVersion: '2.0.0',
                    requirements: [
                        {
                            component: 'core',
                            requiredVersion: '2.0.0',
                            minVersion: '1.5.0',
                            criticalFeatures: [],
                            breakingChanges: ['fee_change'],
                        },
                    ],
                },
            ];

            const report = generateCompatibilityReport(protocols);

            expect(report.overallStatus).toBe('degraded');
        });
    });

    describe('createProtocolFixture', () => {
        it('creates compatible upgrade fixture', () => {
            const fixture = createProtocolFixture(
                'blend-compatible-upgrade',
                'Blend',
                '2.0.0',
                '2.1.0',
                'compatible',
            );

            expect(fixture.name).toBe('blend-compatible-upgrade');
            expect(fixture.protocolName).toBe('Blend');
            expect(fixture.upgradeType).toBe('compatible');
            expect(fixture.expectedIssues).toHaveLength(0);
        });

        it('creates degraded upgrade fixture', () => {
            const fixture = createProtocolFixture(
                'blend-degraded-upgrade',
                'Blend',
                '2.0.0',
                '2.1.0',
                'degraded',
            );

            expect(fixture.upgradeType).toBe('degraded');
            expect(fixture.expectedIssues.some(i => i.severity === 'warning')).toBe(
                true,
            );
        });

        it('creates incompatible upgrade fixture', () => {
            const fixture = createProtocolFixture(
                'blend-incompatible-upgrade',
                'Blend',
                '1.0.0',
                '2.0.0',
                'incompatible',
            );

            expect(fixture.upgradeType).toBe('incompatible');
            expect(fixture.expectedIssues.some(i => i.severity === 'critical')).toBe(
                true,
            );
        });
    });
});
