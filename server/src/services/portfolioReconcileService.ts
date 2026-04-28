export interface PortfolioPosition {
  assetId: string
  amount: number
  vaultId: string
  protocol: string
}

export interface ReconciliationResult {
  status: 'success' | 'partial' | 'failed'
  changes: PositionChange[]
  mismatches: ReconciliationMismatch[]
  timestamp: Date
  sourceOfTruth: 'chain' | 'backend_snapshot'
}

export interface PositionChange {
  type: 'added' | 'removed' | 'updated'
  position: PortfolioPosition
  previousAmount?: number
  currentAmount: number
}

export interface ReconciliationMismatch {
  assetId: string
  chainValue: number
  cachedValue: number
  discrepancy: number
  severity: 'info' | 'warning' | 'critical'
}

interface PrismaVaultBalance {
  findUnique(opts: Record<string, unknown>): Promise<Record<string, unknown> | null>
  upsert(opts: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface PrismaClient {
  vaultBalance: PrismaVaultBalance
}

export class PortfolioReconcileService {
  constructor(private prisma: PrismaClient) {}

  async reconcilePortfolio(
    walletAddress: string,
    forceChainRevalidation: boolean = false
  ): Promise<ReconciliationResult> {
    const changes: PositionChange[] = []
    const mismatches: ReconciliationMismatch[] = []

    try {
      // Step 1: Fetch chain-authoritative state
      const chainPositions = await this.fetchChainPositions(walletAddress)

      // Step 2: Fetch cached state from backend
      const cachedPositions = await this.fetchCachedPositions(walletAddress)

      // Step 3: Compare and identify discrepancies
      const comparisonResult = this.comparePositions(chainPositions, cachedPositions)
      changes.push(...comparisonResult.changes)
      mismatches.push(...comparisonResult.mismatches)

      // Step 4: Update cache to match chain (with confirmation)
      if (!forceChainRevalidation) {
        // In production, this would require user confirmation
        await this.updateCachedPositions(walletAddress, chainPositions)
      }

      // Step 5: Audit and log reconciliation
      await this.logReconciliationEvent(walletAddress, changes, mismatches)

      return {
        status: mismatches.length === 0 ? 'success' : 'partial',
        changes,
        mismatches,
        timestamp: new Date(),
        sourceOfTruth: 'chain',
      }
    } catch (error) {
      await this.logReconciliationEvent(walletAddress, [], [], 'failed', error)
      return {
        status: 'failed',
        changes: [],
        mismatches: [],
        timestamp: new Date(),
        sourceOfTruth: 'chain',
      }
    }
  }

  private comparePositions(
    chainPositions: PortfolioPosition[],
    cachedPositions: PortfolioPosition[]
  ) {
    const changes: PositionChange[] = []
    const mismatches: ReconciliationMismatch[] = []

    const chainMap = new Map(chainPositions.map(p => [p.assetId, p]))
    const cachedMap = new Map(cachedPositions.map(p => [p.assetId, p]))

    // Find added and updated positions
    for (const [assetId, chainPos] of chainMap.entries()) {
      const cachedPos = cachedMap.get(assetId)

      if (!cachedPos) {
        changes.push({
          type: 'added',
          position: chainPos,
          currentAmount: chainPos.amount,
        })
      } else if (Math.abs(chainPos.amount - cachedPos.amount) > 0.0001) {
        changes.push({
          type: 'updated',
          position: chainPos,
          previousAmount: cachedPos.amount,
          currentAmount: chainPos.amount,
        })

        const discrepancy = Math.abs(chainPos.amount - cachedPos.amount)
        const severity =
          discrepancy > chainPos.amount * 0.1 ? 'critical' : 'warning'

        mismatches.push({
          assetId,
          chainValue: chainPos.amount,
          cachedValue: cachedPos.amount,
          discrepancy,
          severity,
        })
      }
    }

    // Find removed positions
    for (const [assetId, cachedPos] of cachedMap.entries()) {
      if (!chainMap.has(assetId)) {
        changes.push({
          type: 'removed',
          position: cachedPos,
          previousAmount: cachedPos.amount,
          currentAmount: 0,
        })
      }
    }

    return { changes, mismatches }
  }

  private async fetchChainPositions(
    _walletAddress: string
  ): Promise<PortfolioPosition[]> {
    // In production, this would query the actual blockchain/Stellar network
    // For now, return empty array (would be populated by SDK calls)
    return []
  }

  private async fetchCachedPositions(walletAddress: string): Promise<PortfolioPosition[]> {
    const vaultBalance = await this.prisma.vaultBalance.findUnique({
      where: { walletAddress },
    })

    if (!vaultBalance) return []

    // Map stored balance to positions (simplified - would need position tracking table)
    return [
      {
        assetId: 'USDC',
        amount: vaultBalance.tvl as number,
        vaultId: 'vault-1',
        protocol: 'unknown',
      },
    ]
  }

  private async updateCachedPositions(
    walletAddress: string,
    positions: PortfolioPosition[]
  ): Promise<void> {
    const totalTvl = positions.reduce((sum, p) => sum + p.amount, 0)

    await this.prisma.vaultBalance.upsert({
      where: { walletAddress },
      update: { tvl: totalTvl, updatedAt: new Date() },
      create: {
        walletAddress,
        tvl: totalTvl,
        totalYield: 0,
      },
    })
  }

  private async logReconciliationEvent(
    walletAddress: string,
    changes: PositionChange[],
    mismatches: ReconciliationMismatch[],
    status: string = 'success',
    error?: unknown
  ): Promise<void> {
    const eventData: Record<string, unknown> = {
      walletAddress,
      changes: changes.length,
      mismatches: mismatches.length,
      status,
      timestamp: new Date().toISOString(),
    }
    if (error) {
      eventData.error = String(error)
    }
    console.log('[PortfolioReconcile]', eventData)
  }

  async getReconciliationHistory(
    walletAddress: string,
    _limit: number = 10
  ): Promise<ReconciliationResult[]> {
    // Placeholder for fetching history from audit logs
    return []
  }
}

export function createPortfolioReconcileService(prisma: PrismaClient) {
  return new PortfolioReconcileService(prisma)
}
