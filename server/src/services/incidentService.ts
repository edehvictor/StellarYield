import { PrismaClient, Incident } from "@prisma/client"; // Type verified via tsc
import { recoveryRecommendationService, RecoveryRecommendation, ShockEvent } from "./recoveryRecommendationService";

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
