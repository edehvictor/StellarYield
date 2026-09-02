import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface AllocationProvenance {
  decisionId: string;
  vaultId: string;
  strategyVersion: string;
  timestamp: number;
  triggerContext: {
    condition: string;
    rawInputs: Record<string, number>;
  };
  allocationChange: {
    previous: Record<string, number>;
    updated: Record<string, number>;
  };
  signer: string;
}

export class ProvenanceService {
  async saveDecision(provenance: AllocationProvenance): Promise<AllocationProvenance> {
    const existing = await prisma.allocationProvenance.findUnique({
      where: { decisionId: provenance.decisionId },
    });
    if (existing) {
      throw new Error(`@'` Allocation record with decisionId ${provenance.decisionId} already exists and is immutable.`);
    }
    const created = await prisma.allocationProvenance.create({
      data: {
        decisionId: provenance.decisionId,
        vaultId: provenance.vaultId,
        strategyVersion: provenance.strategyVersion,
        timestamp: new Date(provenance.timestamp),
        triggerCondition: provenance.triggerContext.condition,
        triggerInputs: provenance.triggerContext.rawInputs,
        previousAllocation: provenance.allocationChange.previous,
        updatedAllocation: provenance.allocationChange.updated,
        signer: provenance.signer,
      },
    });
    return this.mapToDTO(created);
  }

  async getHistory(filters: {
    vaultId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<AllocationProvenance[]> {
    const where: any = {};
    if (filters.vaultId) where.vaultId = filters.vaultId;
    if (filters.startTime || filters.endTime) {
      where.timestamp = {};
      if (filters.startTime) where.timestamp.gte = new Date(filters.startTime);
      if (filters.endTime) where.timestamp.lte = new Date(filters.endTime);
    }
    const records = await prisma.allocationProvenance.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: filters.limit || 50,
    });
    return records.map((r) => this.mapToDTO(r));
  }

  private mapToDTO(record: any): AllocationProvenance {
    return {
      decisionId: record.decisionId,
      vaultId: record.vaultId,
      strategyVersion: record.strategyVersion,
      timestamp: record.timestamp.getTime(),
      triggerContext: {
        condition: record.triggerCondition,
        rawInputs: record.triggerInputs as Record<string, number>,
      },
      allocationChange: {
        previous: record.previousAllocation as Record<string, number>,
        updated: record.updatedAllocation as Record<string, number>,
      },
      signer: record.signer,
    };
  }
}

export const provenanceService = new ProvenanceService();

export interface BuildProvenance {
  version: string;
  commit: string;
  buildTime: string;
}

const buildMetadata: Readonly<BuildProvenance> = Object.freeze({
  version: process.env.npm_package_version ?? process.env.GIT_VERSION ?? 'unknown',
  commit: process.env.GIT_COMMIT ?? process.env.SOURCE_VERSION ?? 'unknown',
  buildTime: process.env.BUILD_TIME ?? process.env.BUILD_TIMESTAMP ?? 'unknown',
});

export class BuildProvenanceService {
  getBuildProvenance(): BuildProvenance {
    return buildMetadata;
  }

  stamp(): string {
    return `version=${buildMetadata.version};commit=${buildMetadata.commit};buildTime=${buildMetadata.buildTime}`;
  }

  static parse(stamp: string): BuildProvenance {
    const parts = stamp.split(';');
    const map: Record<string, string> = {};
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        map[part.slice(0, idx)] = part.slice(idx + 1);
      }
    }
    return {
      version: map['version'] ?? 'unknown',
      commit: map['commit'] ?? 'unknown',
      buildTime: map['buildTime'] ?? 'unknown',
    };
  }
}

export const buildProvenanceService = new BuildProvenanceService();
