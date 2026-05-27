import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provenanceService, AllocationProvenance } from '../../src/services/provenance.service';
import { PrismaClient } from '@prisma/client';

// Mock PrismaClient
vi.mock('@prisma/client', () => {
  const mPrisma = {
    allocationProvenance: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return { PrismaClient: vi.fn(() => mPrisma) };
});

const prisma = new PrismaClient() as any;

describe('ProvenanceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockProvenance: AllocationProvenance = {
    decisionId: 'test-uuid-1',
    vaultId: 'vault-xlm-1',
    strategyVersion: '2.1.0',
    timestamp: 1715000000000,
    triggerContext: {
      condition: 'MARKET_VOLATILITY_THRESHOLD',
      rawInputs: { volatility: 0.15 },
    },
    allocationChange: {
      previous: { 'blend': 50, 'soroswap': 50 },
      updated: { 'blend': 70, 'soroswap': 30 },
    },
    signer: 'GB...XYZ',
  };

  describe('saveDecision', () => {
    it('should successfully save a new decision', async () => {
      prisma.allocationProvenance.findUnique.mockResolvedValue(null);
      prisma.allocationProvenance.create.mockImplementation(({ data }: any) => ({
        ...data,
        timestamp: new Date(data.timestamp),
      }));

      const result = await provenanceService.saveDecision(mockProvenance);

      expect(result.decisionId).toBe(mockProvenance.decisionId);
      expect(prisma.allocationProvenance.create).toHaveBeenCalled();
    });

    it('should throw an error if the decisionId already exists (Immutability check)', async () => {
      prisma.allocationProvenance.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(provenanceService.saveDecision(mockProvenance))
        .rejects.toThrow(/already exists/);
      
      expect(prisma.allocationProvenance.create).not.toHaveBeenCalled();
    });
  });

  describe('getHistory', () => {
    it('should fetch history with time window filters', async () => {
      const startTime = 1714000000000;
      const endTime = 1716000000000;

      prisma.allocationProvenance.findMany.mockResolvedValue([]);

      await provenanceService.getHistory({
        vaultId: 'vault-xlm-1',
        startTime,
        endTime,
      });

      expect(prisma.allocationProvenance.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          vaultId: 'vault-xlm-1',
          timestamp: { gte: new Date(startTime), lte: new Date(endTime) },
        },
      }));
    });
  });
});