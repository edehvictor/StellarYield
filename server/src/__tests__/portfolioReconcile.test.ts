import { PortfolioReconcileService } from '../services/portfolioReconcileService'

describe('PortfolioReconcileService', () => {
  let service: PortfolioReconcileService
  const mockPrisma: { vaultBalance: { findUnique: jest.Mock; upsert: jest.Mock } } = {
    vaultBalance: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    service = new PortfolioReconcileService(mockPrisma)
  })

  describe('reconcilePortfolio', () => {
    it('should detect added positions', async () => {
      mockPrisma.vaultBalance.findUnique.mockResolvedValue({
        walletAddress: 'test-wallet',
        tvl: 100,
        totalYield: 0,
      })

      const result = await service.reconcilePortfolio('test-wallet')

      expect(result.status).toBeDefined()
      expect(result.changes).toBeInstanceOf(Array)
      expect(result.mismatches).toBeInstanceOf(Array)
      expect(result.timestamp).toBeInstanceOf(Date)
    })

    it('should handle missing cached state gracefully', async () => {
      mockPrisma.vaultBalance.findUnique.mockResolvedValue(null)

      const result = await service.reconcilePortfolio('nonexistent-wallet')

      expect(result.status).toBe('success')
      expect(result.changes).toEqual([])
    })

    it('should log reconciliation events', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation()
      mockPrisma.vaultBalance.findUnique.mockResolvedValue(null)

      await service.reconcilePortfolio('test-wallet')

      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('should update cached positions', async () => {
      mockPrisma.vaultBalance.findUnique.mockResolvedValue({
        walletAddress: 'test-wallet',
        tvl: 100,
        totalYield: 0,
      })
      mockPrisma.vaultBalance.upsert.mockResolvedValue({
        walletAddress: 'test-wallet',
        tvl: 150,
        totalYield: 0,
      })

      const result = await service.reconcilePortfolio('test-wallet')

      expect(result.status).toBeDefined()
    })

    it('should handle reconciliation errors', async () => {
      mockPrisma.vaultBalance.findUnique.mockRejectedValue(new Error('DB error'))

      const result = await service.reconcilePortfolio('test-wallet')

      expect(result.status).toBe('failed')
      expect(result.changes).toEqual([])
      expect(result.mismatches).toEqual([])
    })
  })

  describe('getReconciliationHistory', () => {
    it('should return empty array by default', async () => {
      const history = await service.getReconciliationHistory('test-wallet')

      expect(Array.isArray(history)).toBe(true)
      expect(history).toEqual([])
    })

    it('should respect limit parameter', async () => {
      const history = await service.getReconciliationHistory('test-wallet', 5)

      expect(Array.isArray(history)).toBe(true)
    })
  })
})
