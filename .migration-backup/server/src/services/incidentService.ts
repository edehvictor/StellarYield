import { PrismaClient, Incident } from "@prisma/client"; // Type verified via tsc
import { recoveryRecommendationService, RecoveryRecommendation, ShockEvent, ShockEventType } from "./recoveryRecommendationService";
import {
    PaginatedResponse,
    PAGINATION_DEFAULT_LIMIT,
    PAGINATION_MAX_LIMIT,
    decodeTimelineCursor,
    encodeTimelineCursor,
} from "../types/pagination";
import { normalizeSeverity } from "../utils/alertSeverity";
import {
    buildMergedIncidentTimeline,
    DEFAULT_DUPLICATE_WINDOW_MS,
    IncidentTimelineRecord,
    MergedIncidentTimelineEntry,
} from "./incidentTimelineMerge";

const prisma = new PrismaClient();

export interface IncidentFilter {
    protocol?: string;
    severity?: string;
    type?: string;
    resolved?: boolean;
}

export interface IncidentPageOptions {
    cursor?: string;
    limit?: number;
}

export interface IncidentWithRecommendations extends Incident {
    recommendations: RecoveryRecommendation[];
}

export const INCIDENT_POSTMORTEM_TEMPLATE_PATH = "docs/postmortems/TEMPLATE.md";
export const INCIDENT_POSTMORTEM_LINK_FIELD = "postmortemUrl";

export interface IncidentPostmortemGuidance {
    incidentId: string;
    title: string;
    status: "open" | "resolved";
    templatePath: string;
    expectedPostmortemPath: string;
    linkField: string;
    displayLabel: string;
    transparencyHint: string;
}

function slugifyIncidentTitle(title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72);

    return slug || "incident";
}

export class IncidentService {
    async createIncident(data: {
        protocol: string;
        severity: string;
        type: string;
        title: string;
        description: string;
        affectedVaults: string[];
        startedAt: Date;
    }): Promise<Incident> {
        // Normalize severity (#1318) so callers passing inconsistent labels
        // (e.g. "critical", "Error", "sev1") converge on the same LOW/MEDIUM/
        // HIGH/CRITICAL levels used everywhere severity is read downstream —
        // including the `incident.severity as ShockEvent["severity"]` cast in
        // getRecommendationsForIncident, which otherwise assumes (unchecked)
        // that severity is already one of those four values.
        return prisma.incident.create({
            data: {
                ...data,
                severity: normalizeSeverity(data.severity),
            },
        });
    }

    async resolveIncident(id: string, resolvedAt: Date = new Date()): Promise<Incident> {
        return prisma.incident.update({
            where: { id },
            data: {
                resolved: true,
                resolvedAt,
            },
        });
    }

    async getIncidents(filter: IncidentFilter): Promise<Incident[]> {
        return prisma.incident.findMany({
            where: {
                protocol: filter.protocol,
                severity: filter.severity,
                type: filter.type,
                resolved: filter.resolved,
            },
            orderBy: {
                startedAt: "desc",
            },
        });
    }

    async getIncidentsPaginated(
        filter: IncidentFilter,
        options: IncidentPageOptions,
    ): Promise<PaginatedResponse<Incident>> {
        const limit = Math.min(
            Math.max(1, options.limit ?? PAGINATION_DEFAULT_LIMIT),
            PAGINATION_MAX_LIMIT,
        );

        // Stable cursor (#1071): `id` is a random UUID with no relationship
        // to `startedAt` order, so an id-only cursor can skip or duplicate
        // rows. Decode a compound (startedAt, id) cursor instead, and page
        // using the same compound ordering the query sorts by.
        const cursor = decodeTimelineCursor(options.cursor);

        const rows = await prisma.incident.findMany({
            where: {
                protocol: filter.protocol || undefined,
                severity: filter.severity || undefined,
                type: filter.type || undefined,
                resolved: filter.resolved,
                ...(cursor
                    ? {
                          OR: [
                              { startedAt: { lt: new Date(cursor.ts) } },
                              {
                                  startedAt: new Date(cursor.ts),
                                  id: { lt: cursor.id },
                              },
                          ],
                      }
                    : {}),
            },
            orderBy: [{ startedAt: "desc" }, { id: "desc" }],
            // Fetch one extra to determine whether a next page exists.
            take: limit + 1,
        });

        const hasMore = rows.length > limit;
        const data = hasMore ? rows.slice(0, limit) : rows;
        const last = data[data.length - 1];
        const nextCursor =
            hasMore && last
                ? encodeTimelineCursor({ ts: last.startedAt.getTime(), id: last.id })
                : null;

        return { data, pagination: { nextCursor, hasMore, limit } };
    }

    async getIncidentById(id: string): Promise<Incident | null> {
        return prisma.incident.findUnique({
            where: { id },
        });
    }

    getPostmortemLinkingGuidance(
        incident: Pick<Incident, "id" | "title" | "startedAt" | "resolved">
    ): IncidentPostmortemGuidance {
        const date = incident.startedAt.toISOString().slice(0, 10);
        const slug = slugifyIncidentTitle(incident.title);

        return {
            incidentId: incident.id,
            title: incident.title,
            status: incident.resolved ? "resolved" : "open",
            templatePath: INCIDENT_POSTMORTEM_TEMPLATE_PATH,
            expectedPostmortemPath: `docs/postmortems/${date}-${slug}.md`,
            linkField: INCIDENT_POSTMORTEM_LINK_FIELD,
            displayLabel: `Postmortem: ${incident.title}`,
            transparencyHint:
                "Render postmortemUrl in incident records and transparency views after mitigation or resolution.",
        };
    }

    async getRecommendationsForIncident(id: string): Promise<RecoveryRecommendation[]> {
        const incident = await this.getIncidentById(id);
        if (!incident) return [];

        const recommendations: RecoveryRecommendation[] = [];
        
        for (const vaultId of incident.affectedVaults) {
            const shockEvent: ShockEvent = {
                type: this.mapIncidentTypeToShockType(incident.type),
                severity: incident.severity as ShockEvent["severity"],
                vaultId,
                protocol: incident.protocol,
                description: incident.description,
                timestamp: incident.startedAt.getTime(),
            };
            
            const vaultRecs = await recoveryRecommendationService.evaluateRecoveryOptions(shockEvent);
            recommendations.push(...vaultRecs);
        }

        return recommendations;
    }

    private mapIncidentTypeToShockType(incidentType: string): ShockEventType {
        switch (incidentType) {
            case "PAUSE":
            case "ANOMALY":
                return "ORACLE_ANOMALY";
            case "DEPEG":
            case "LIQUIDITY":
                return "LIQUIDITY_EVENT";
            case "YIELD_CRASH":
            case "APY_DROP":
                return "APY_CRASH";
            default:
                return "APY_CRASH"; // Fallback
        }
    }

    async linkPostmortem(id: string, postmortemUrl: string): Promise<Incident> {
        return prisma.incident.update({
            where: { id },
            data: { postmortemUrl },
        });
    }

    /**
     * Merges duplicate incident notifications from different sources (#1110)
     * into a single timeline entry per real-world incident.
     *
     * Callers pass the raw, source-tagged notifications they've collected
     * (e.g. from an on-chain monitor adapter and a manual/ops-report
     * adapter) rather than this reading from a single `source` column,
     * since `Incident` records persisted via `createIncident` don't carry
     * per-notification source provenance today. See
     * `incidentTimelineMerge.ts` for the exact duplicate-detection window
     * and per-field tie-break rules used during the merge.
     */
    mergeTimelineNotifications(
        records: IncidentTimelineRecord[],
        windowMs: number = DEFAULT_DUPLICATE_WINDOW_MS,
    ): MergedIncidentTimelineEntry[] {
        return buildMergedIncidentTimeline(records, windowMs);
    }
}

export const incidentService = new IncidentService();
