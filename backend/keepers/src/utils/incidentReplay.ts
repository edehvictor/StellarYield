import { logger } from './logger';
import { config } from '../config';

/**
 * Represents an exported incident event for replay purposes.
 */
export interface IncidentEvent {
    ledger: number;
    timestamp: string;
    type: 'vault_state_change' | 'liquidation_trigger' | 'compound_execution' | 'price_update' | 'error';
    vaultId?: string;
    accountAddress?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}

/**
 * Represents a keeper audit decision.
 */
export interface KeeperAuditDecision {
    timestamp: string;
    jobId: string;
    type: 'liquidation_trigger' | 'liquidation_execute' | 'compound_trigger' | 'compound_execute';
    accountAddress?: string;
    vaultId?: string;
    decision: 'approve' | 'reject' | 'defer';
    evidence: string;
    confidence: number;
    transactionHash?: string;
    error?: string;
}

/**
 * Represents a detected anomaly.
 */
export interface DetectedAnomaly {
    ledger: number;
    timestamp: string;
    type: 'collateral_ratio_drop' | 'fee_spike' | 'oracle_deviation' | 'queue_stall' | 'liquidation_failure';
    severity: 'low' | 'medium' | 'high' | 'critical';
    affectedVaults?: string[];
    details: string;
    threshold?: number;
    observed?: number;
}

/**
 * A broken or suspicious replay chain surfaced by `detectReplayAnomalies`.
 * Operator-facing: each entry explains what went wrong so a clean replay is
 * never implied when checkpoints are missing or events are out of order.
 */
export type ReplayAnomalyType = 'missing-checkpoint' | 'out-of-order' | 'incomplete-sequence';

export interface ReplayAnomaly {
    type: ReplayAnomalyType;
    ledger: number;
    expectedLedger?: number;
    details: string;
}

/**
 * Exported incident data structure.
 */
export interface IncidentExport {
    ledgerRange: { from: number; to: number };
    exportedAt: string;
    events: IncidentEvent[];
    decisions: KeeperAuditDecision[];
    anomalies: DetectedAnomaly[];
    replayAnomalies: ReplayAnomaly[];
    affectedVaults: string[];
    affectedAccounts: string[];
    summary: {
        eventCount: number;
        decisionCount: number;
        anomalyCount: number;
        replayAnomalyCount: number;
    };
}

/**
 * User impact summary for an incident.
 */
export interface UserImpactSummary {
    incidentId: string;
    duration: string;
    affectedVaults: string[];
    affectedAccounts: number;
    liquidations: {
        triggered: number;
        successful: number;
        partial: number;
        failed: number;
    };
    recovery: {
        collateralRecovered: string;
        totalAtRisk: string;
        recoveryPercentage: number;
    };
    unresolvedAnomalies: DetectedAnomaly[];
}

/**
 * Detects broken replay chains in an incident export.
 *
 * Instead of implying a clean replay, this surfaces explicit anomalies when:
 * - a checkpoint is missing: consecutive events skip ledgers inside the range
 * - the sequence is incomplete: no events cover the range start/end boundaries
 * - events are out of order: ledgers do not appear in ascending sequence
 *
 * @param export_ - Incident export to inspect
 */
export function detectReplayAnomalies(export_: IncidentExport): ReplayAnomaly[] {
    const anomalies: ReplayAnomaly[] = [];
    const { from, to } = export_.ledgerRange;
    const events = export_.events;

    if (events.length === 0) {
        anomalies.push({
            type: 'incomplete-sequence',
            ledger: from,
            expectedLedger: from,
            details: `No events recorded for ledger range [${from}, ${to}]`,
        });
        return anomalies;
    }

    // Out-of-order: ledgers must not decrease relative to the prior event.
    for (let i = 1; i < events.length; i++) {
        if (events[i].ledger < events[i - 1].ledger) {
            anomalies.push({
                type: 'out-of-order',
                ledger: events[i].ledger,
                expectedLedger: events[i - 1].ledger,
                details: `Event at ledger ${events[i].ledger} appears before event at ledger ${events[i - 1].ledger}`,
            });
        }
    }

    // Missing checkpoints / incomplete range: analyze sorted ledger coverage.
    const sorted = [...events].map((e) => e.ledger).sort((a, b) => a - b);
    const firstLedger = sorted[0];
    const lastLedger = sorted[sorted.length - 1];

    if (firstLedger > from) {
        anomalies.push({
            type: 'incomplete-sequence',
            ledger: firstLedger,
            expectedLedger: from,
            details: `Replay starts at ledger ${firstLedger}; missing checkpoint coverage from ledger ${from}`,
        });
    }
    if (lastLedger < to) {
        anomalies.push({
            type: 'incomplete-sequence',
            ledger: lastLedger,
            expectedLedger: to,
            details: `Replay ends at ledger ${lastLedger}; missing checkpoint coverage through ledger ${to}`,
        });
    }

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] > sorted[i - 1] + 1) {
            anomalies.push({
                type: 'missing-checkpoint',
                ledger: sorted[i],
                expectedLedger: sorted[i - 1] + 1,
                details: `Missing checkpoint(s) between ledger ${sorted[i - 1]} and ledger ${sorted[i]}`,
            });
        }
    }

    return anomalies;
}

/**
 * Exports incident events from a ledger range.
 * Reads from keeper queue history and vault state snapshots.
 * Operates in read-only mode by default.
 *
 * @param fromLedger - Starting ledger sequence
 * @param toLedger - Ending ledger sequence
 * @param readOnly - If true, don't mutate any state (default: true)
 */
export async function exportIncidentEvents(
    fromLedger: number,
    toLedger: number,
    readOnly = true,
): Promise<IncidentExport> {
    logger.info(
        { fromLedger, toLedger, readOnly },
        '[IncidentReplay] Exporting events for ledger window',
    );

    if (readOnly === false && process.env.NODE_ENV !== 'staging') {
        throw new Error('Mutations only allowed in staging environment');
    }

    // TODO: Implement event export from queue history
    // 1. Query Redis sorted sets for completed/failed jobs in ledger range
    // 2. Query vault state snapshots
    // 3. Cross-reference with on-chain ledger entries
    // 4. Collect all anomalies

    const events: IncidentEvent[] = [];
    const decisions: KeeperAuditDecision[] = [];
    const anomalies: DetectedAnomaly[] = [];
    const affectedVaults = new Set<string>();
    const affectedAccounts = new Set<string>();

    const export_: IncidentExport = {
        ledgerRange: { from: fromLedger, to: toLedger },
        exportedAt: new Date().toISOString(),
        events,
        decisions,
        anomalies,
        replayAnomalies: [],
        affectedVaults: Array.from(affectedVaults),
        affectedAccounts: Array.from(affectedAccounts),
        summary: {
            eventCount: events.length,
            decisionCount: decisions.length,
            anomalyCount: anomalies.length,
            replayAnomalyCount: 0,
        },
    };

    // Placeholder: no events are populated yet, so the replay chain is
    // incomplete rather than clean. Detect and surface that explicitly.
    export_.replayAnomalies = detectReplayAnomalies(export_);
    export_.summary.replayAnomalyCount = export_.replayAnomalies.length;

    return export_;
}

/**
 * Analyzes keeper audit logs for an incident.
 * Extracts decision timeline and validates against on-chain state.
 *
 * @param incidentId - Incident identifier
 * @param validateAgainstLedger - Cross-reference with on-chain state
 */
export async function analyzeKeeperAuditLogs(
    incidentId: string,
    validateAgainstLedger = false,
): Promise<KeeperAuditDecision[]> {
    logger.info(
        { incidentId, validateAgainstLedger },
        '[IncidentReplay] Analyzing keeper audit logs',
    );

    // TODO: Implement audit log analysis
    // 1. Query Pino logs for keeper service records
    // 2. Filter by incident ID and timeframe
    // 3. Extract decision records (liquidation, compound)
    // 4. If validateAgainstLedger: verify decisions match outcomes

    const decisions: KeeperAuditDecision[] = [];

    return decisions;
}

/**
 * Generates user impact summary from incident data.
 * Does not include sensitive data (addresses, keys).
 *
 * @param incidentId - Incident identifier
 * @param export_ - Incident export data
 */
export async function generateUserImpactSummary(
    incidentId: string,
    export_: IncidentExport,
): Promise<UserImpactSummary> {
    logger.info({ incidentId }, '[IncidentReplay] Generating user impact summary');

    // TODO: Implement impact summary
    // 1. Count affected vaults and accounts (sanitized)
    // 2. Aggregate liquidation outcomes
    // 3. Calculate recovery percentage
    // 4. Identify unresolved anomalies

    const summary: UserImpactSummary = {
        incidentId,
        duration: 'unknown',
        affectedVaults: export_.affectedVaults,
        affectedAccounts: export_.affectedAccounts.length,
        liquidations: {
            triggered: 0,
            successful: 0,
            partial: 0,
            failed: 0,
        },
        recovery: {
            collateralRecovered: '0',
            totalAtRisk: '0',
            recoveryPercentage: 0,
        },
        unresolvedAnomalies: export_.anomalies.filter((a) => a.severity === 'high' || a.severity === 'critical'),
    };

    return summary;
}

/**
 * Validates incident replay export against schema.
 * Ensures no sensitive data leaks.
 *
 * @param export_ - Incident export to validate
 */
export function validateIncidentExport(export_: IncidentExport): string[] {
    const errors: string[] = [];

    // Validate structure
    if (!export_.ledgerRange || !export_.ledgerRange.from || !export_.ledgerRange.to) {
        errors.push('Missing or invalid ledgerRange');
    }

    if (!export_.exportedAt || isNaN(new Date(export_.exportedAt).getTime())) {
        errors.push('Invalid or missing exportedAt timestamp');
    }

    if (!Array.isArray(export_.events)) {
        errors.push('events must be an array');
    }

    if (!Array.isArray(export_.decisions)) {
        errors.push('decisions must be an array');
    }

    if (!Array.isArray(export_.anomalies)) {
        errors.push('anomalies must be an array');
    }

    if (!Array.isArray(export_.replayAnomalies)) {
        errors.push('replayAnomalies must be an array');
    }

    // Broken replay chains must not be reported as a clean replay.
    const replayAnomalies =
        Array.isArray(export_.replayAnomalies) && Array.isArray(export_.events)
            ? detectReplayAnomalies(export_)
            : [];
    for (const anomaly of replayAnomalies) {
        errors.push(`Replay ${anomaly.type}: ${anomaly.details}`);
    }

    // Check for sensitive data in export
    const exportJson = JSON.stringify(export_);
    if (/[Ss]ecret|[Pp]rivate[Kk]ey|[Aa]pi[Kk]ey/.test(exportJson)) {
        errors.push('Export contains potential secrets (secret, privateKey, apiKey)');
    }

    // Validate vault and account count
    if (export_.affectedVaults.length !== export_.summary.eventCount && export_.summary.eventCount > 0) {
        logger.warn('[IncidentReplay] Vault count mismatch with event count');
    }

    return errors;
}
