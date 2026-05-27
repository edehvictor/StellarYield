import { PrismaClient, Incident } from "@prisma/client"; // Type verified via tsc
import { recoveryRecommendationService, RecoveryRecommendation, ShockEvent, ShockEventType } from "./recoveryRecommendationService";

const prisma = new PrismaClient();

export interface IncidentFilter {
    protocol?: string;
    severity?: string;
    type?: string;
    resolved?: boolean;
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
        return prisma.incident.create({
            data,
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
}

export const incidentService = new IncidentService();
