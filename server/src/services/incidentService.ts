import { PrismaClient, Incident } from "@prisma/client"; // Type verified via tsc

const prisma = new PrismaClient();

export interface IncidentFilter {
    protocol?: string;
    severity?: string;
    type?: string;
    resolved?: boolean;
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
}

export const incidentService = new IncidentService();
