import {
    exportIncidentEvents,
    analyzeKeeperAuditLogs,
    generateUserImpactSummary,
    validateIncidentExport,
    detectReplayAnomalies,
    type IncidentExport,
} from '../utils/incidentReplay';
import cleanReplayFixture from './fixtures/incidents/clean-replay.json';
import missingCheckpointFixture from './fixtures/incidents/missing-checkpoint.json';
import outOfOrderFixture from './fixtures/incidents/out-of-order.json';
import incompleteSequenceFixture from './fixtures/incidents/incomplete-sequence.json';

describe('Incident Replay', () => {
    describe('exportIncidentEvents', () => {
        it('exports events for ledger range', async () => {
            const export_ = await exportIncidentEvents(50000000, 50001000);

            expect(export_).toBeDefined();
            expect(export_.ledgerRange.from).toBe(50000000);
            expect(export_.ledgerRange.to).toBe(50001000);
            expect(Array.isArray(export_.events)).toBe(true);
            expect(Array.isArray(export_.decisions)).toBe(true);
            expect(Array.isArray(export_.anomalies)).toBe(true);
        });

        it('rejects mutations outside staging', async () => {
            if (process.env.NODE_ENV !== 'staging') {
                await expect(exportIncidentEvents(50000000, 50001000, false)).rejects.toThrow(
                    'Mutations only allowed in staging environment',
                );
            }
        });

        it('operates in read-only mode by default', async () => {
            const export_ = await exportIncidentEvents(50000000, 50001000);
            // Verify no state changes (implementation detail)
            expect(export_.summary.eventCount).toBe(export_.events.length);
        });
    });

    describe('analyzeKeeperAuditLogs', () => {
        it('extracts keeper decisions', async () => {
            const decisions = await analyzeKeeperAuditLogs('INC-001');

            expect(Array.isArray(decisions)).toBe(true);
            decisions.forEach((d) => {
                expect(d.timestamp).toBeDefined();
                expect(d.jobId).toBeDefined();
                expect(['liquidation_trigger', 'liquidation_execute', 'compound_trigger', 'compound_execute']).toContain(
                    d.type,
                );
                expect(['approve', 'reject', 'defer']).toContain(d.decision);
            });
        });

        it('validates keeper decisions against ledger', async () => {
            const decisions = await analyzeKeeperAuditLogs('INC-001', true);
            // Should complete without error when validateAgainstLedger is true
            expect(Array.isArray(decisions)).toBe(true);
        });
    });

    describe('generateUserImpactSummary', () => {
        it('generates impact summary from export', async () => {
            const mockExport: IncidentExport = {
                ledgerRange: { from: 50000000, to: 50001000 },
                exportedAt: new Date().toISOString(),
                events: [],
                decisions: [],
                anomalies: [],
                replayAnomalies: [],
                affectedVaults: ['vault_1', 'vault_2'],
                affectedAccounts: ['acc_1', 'acc_2'],
                summary: { eventCount: 0, decisionCount: 0, anomalyCount: 0, replayAnomalyCount: 0 },
            };

            const impact = await generateUserImpactSummary('INC-001', mockExport);

            expect(impact.incidentId).toBe('INC-001');
            expect(impact.affectedVaults).toEqual(['vault_1', 'vault_2']);
            expect(impact.affectedAccounts).toBe(2);
            expect(impact.liquidations).toBeDefined();
            expect(impact.recovery).toBeDefined();
        });

        it('lists unresolved anomalies', async () => {
            const mockExport: IncidentExport = {
                ledgerRange: { from: 50000000, to: 50001000 },
                exportedAt: new Date().toISOString(),
                events: [],
                decisions: [],
                anomalies: [
                    {
                        ledger: 50000050,
                        timestamp: new Date().toISOString(),
                        type: 'collateral_ratio_drop',
                        severity: 'critical',
                        details: 'CR below MCR',
                    },
                    {
                        ledger: 50000100,
                        timestamp: new Date().toISOString(),
                        type: 'oracle_deviation',
                        severity: 'low',
                        details: 'Minor price deviation',
                    },
                ],
                replayAnomalies: [],
                affectedVaults: [],
                affectedAccounts: [],
                summary: { eventCount: 0, decisionCount: 0, anomalyCount: 2, replayAnomalyCount: 0 },
            };

            const impact = await generateUserImpactSummary('INC-001', mockExport);

            expect(impact.unresolvedAnomalies.length).toBe(1); // Only high/critical
            expect(impact.unresolvedAnomalies[0].severity).toBe('critical');
        });
    });

    describe('validateIncidentExport', () => {
        it('validates correct export structure', () => {
            const validExport: IncidentExport = {
                ledgerRange: { from: 50000000, to: 50000002 },
                exportedAt: new Date().toISOString(),
                events: [
                    { ledger: 50000000, timestamp: new Date().toISOString(), type: 'vault_state_change' },
                    { ledger: 50000001, timestamp: new Date().toISOString(), type: 'price_update' },
                    { ledger: 50000002, timestamp: new Date().toISOString(), type: 'vault_state_change' },
                ],
                decisions: [],
                anomalies: [],
                replayAnomalies: [],
                affectedVaults: [],
                affectedAccounts: [],
                summary: { eventCount: 3, decisionCount: 0, anomalyCount: 0, replayAnomalyCount: 0 },
            };

            const errors = validateIncidentExport(validExport);
            expect(errors.length).toBe(0);
        });

        it('detects missing ledgerRange', () => {
            const invalidExport = {
                exportedAt: new Date().toISOString(),
                events: [],
                decisions: [],
                anomalies: [],
                affectedVaults: [],
                affectedAccounts: [],
                summary: { eventCount: 0, decisionCount: 0, anomalyCount: 0 },
            } as any;

            const errors = validateIncidentExport(invalidExport);
            expect(errors.some((e) => e.includes('ledgerRange'))).toBe(true);
        });

        it('detects invalid timestamp', () => {
            const invalidExport: any = {
                ledgerRange: { from: 50000000, to: 50001000 },
                exportedAt: 'invalid-date',
                events: [],
                decisions: [],
                anomalies: [],
                replayAnomalies: [],
                affectedVaults: [],
                affectedAccounts: [],
                summary: { eventCount: 0, decisionCount: 0, anomalyCount: 0, replayAnomalyCount: 0 },
            };

            const errors = validateIncidentExport(invalidExport);
            expect(errors.some((e) => e.includes('exportedAt'))).toBe(true);
        });

        it('detects potential secrets in export', () => {
            const exportWithSecret: IncidentExport = {
                ledgerRange: { from: 50000000, to: 50001000 },
                exportedAt: new Date().toISOString(),
                events: [
                    {
                        ledger: 50000000,
                        timestamp: new Date().toISOString(),
                        type: 'vault_state_change',
                        metadata: { privateKey: 'secret_key_here' },
                    },
                ],
                decisions: [],
                anomalies: [],
                replayAnomalies: [],
                affectedVaults: [],
                affectedAccounts: [],
                summary: { eventCount: 1, decisionCount: 0, anomalyCount: 0, replayAnomalyCount: 0 },
            };

            const errors = validateIncidentExport(exportWithSecret);
            expect(errors.some((e) => e.includes('secrets'))).toBe(true);
        });

        it('detects non-array fields', () => {
            const invalidExport: any = {
                ledgerRange: { from: 50000000, to: 50001000 },
                exportedAt: new Date().toISOString(),
                events: 'not an array',
                decisions: [],
                anomalies: [],
                replayAnomalies: [],
                affectedVaults: [],
                affectedAccounts: [],
                summary: { eventCount: 0, decisionCount: 0, anomalyCount: 0, replayAnomalyCount: 0 },
            };

            const errors = validateIncidentExport(invalidExport);
            expect(errors.some((e) => e.includes('array'))).toBe(true);
        });
    });

    describe('Integration: Full Replay Flow', () => {
        it('exports, analyzes, and summarizes incident', async () => {
            const export_ = await exportIncidentEvents(50000000, 50001000);
            const decisions = await analyzeKeeperAuditLogs('INC-001');
            const impact = await generateUserImpactSummary('INC-001', export_);

            // All components should complete without error
            expect(export_.ledgerRange.from).toBe(50000000);
            expect(Array.isArray(decisions)).toBe(true);
            expect(impact.incidentId).toBe('INC-001');

            // An export with no events over a ledger range is an incomplete
            // replay, not a clean one — it must be surfaced explicitly.
            expect(export_.replayAnomalies.length).toBeGreaterThan(0);
            expect(export_.replayAnomalies[0].type).toBe('incomplete-sequence');
            expect(export_.summary.replayAnomalyCount).toBe(export_.replayAnomalies.length);

            const errors = validateIncidentExport(export_);
            expect(errors.some((e) => e.includes('Replay incomplete-sequence'))).toBe(true);
        });
    });

    describe('detectReplayAnomalies', () => {
        it('reports no anomalies for a clean contiguous replay', () => {
            const anomalies = detectReplayAnomalies(cleanReplayFixture as IncidentExport);

            expect(anomalies).toEqual([]);
        });

        it('detects a missing checkpoint between consecutive events', () => {
            const anomalies = detectReplayAnomalies(missingCheckpointFixture as IncidentExport);

            expect(anomalies.length).toBeGreaterThan(0);
            expect(anomalies.some((a) => a.type === 'missing-checkpoint')).toBe(true);
            const missing = anomalies.find((a) => a.type === 'missing-checkpoint');
            expect(missing?.expectedLedger).toBe(102);
            expect(missing?.details).toMatch(/Missing checkpoint/);
        });

        it('detects out-of-order events in a replay sequence', () => {
            const anomalies = detectReplayAnomalies(outOfOrderFixture as IncidentExport);

            expect(anomalies.some((a) => a.type === 'out-of-order')).toBe(true);
            const reordered = anomalies.find((a) => a.type === 'out-of-order');
            expect(reordered?.ledger).toBe(101);
        });

        it('detects an incomplete replay sequence', () => {
            const anomalies = detectReplayAnomalies(incompleteSequenceFixture as IncidentExport);

            expect(anomalies.some((a) => a.type === 'incomplete-sequence')).toBe(true);
            expect(anomalies.some((a) => a.details.includes('Replay starts at ledger 101'))).toBe(true);
            expect(anomalies.some((a) => a.details.includes('Replay ends at ledger 103'))).toBe(true);
        });

        it('flags an export with no events as incomplete', () => {
            const export_: IncidentExport = {
                ledgerRange: { from: 100, to: 105 },
                exportedAt: new Date().toISOString(),
                events: [],
                decisions: [],
                anomalies: [],
                replayAnomalies: [],
                affectedVaults: [],
                affectedAccounts: [],
                summary: { eventCount: 0, decisionCount: 0, anomalyCount: 0, replayAnomalyCount: 0 },
            };

            const anomalies = detectReplayAnomalies(export_);
            expect(anomalies).toHaveLength(1);
            expect(anomalies[0].type).toBe('incomplete-sequence');
            expect(anomalies[0].details).toMatch(/No events recorded/);
        });
    });

    describe('Replay anomalies in operator-facing output', () => {
        it('exportIncidentEvents surfaces replay anomalies instead of a clean replay', async () => {
            const export_ = await exportIncidentEvents(100, 105);

            expect(export_.replayAnomalies.length).toBeGreaterThan(0);
            expect(export_.summary.replayAnomalyCount).toBe(export_.replayAnomalies.length);
            expect(export_.replayAnomalies.every((a) => a.details.length > 0)).toBe(true);
        });

        it('validateIncidentExport rejects broken replay chains explicitly', () => {
            const errors = validateIncidentExport(missingCheckpointFixture as IncidentExport);
            expect(errors.some((e) => e.includes('Replay missing-checkpoint'))).toBe(true);

            const cleanErrors = validateIncidentExport(cleanReplayFixture as IncidentExport);
            expect(cleanErrors).toHaveLength(0);
        });
    });
});
