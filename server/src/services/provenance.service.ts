import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Represents a single allocation decision for audit trails.
 * Requirements: Immutable, searchable, no secrets.
 */
export interface AllocationProvenance {
  decisionId: string;      // Unique UUID
  vaultId: string;         // Target Vault
  strategyVersion: string; // Current strategy logic version
  timestamp: number;       // ISO or Unix timestamp for time-window lookups
  
  // Input triggers (e.g., APY changes, Liquidity shifts)
  triggerContext: {
    condition: string;     // e.g., "MARKET_VOLATILITY_THRESHOLD"
    rawInputs: Record<string, number>; 
  };

  // The actual change made
  allocationChange: {
    previous: Record<string, number>;
    updated: Record<string, number>;
  };

  signer: string;          // Wallet address that triggered/signed the change
}

export class ProvenanceService {
  /**
   * Saves an allocation decision to the database.
   * Implements immutability by preventing overrides of existing decision IDs.
   */
  async saveDecision(provenance: AllocationProvenance): Promise<AllocationProvenance> {
    const existing = await prisma.allocationProvenance.findUnique({
      where: { decisionId: provenance.decisionId },
    });

    if (existing) {
      throw new Error(`Allocation record with decisionId ${provenance.decisionId} already exists and is immutable.`);
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

  /**
   * Retrieves historical allocation records with optional filters.
   */
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