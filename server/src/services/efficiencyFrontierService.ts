import { PROTOCOLS } from "../config/protocols";

export interface FrontierPoint {
  risk: number; // Volatility or standard deviation
  return: number; // APY
  allocation: Record<string, number>; // strategyId -> percentage
}

export interface EfficiencyFrontierResult {
  frontier: FrontierPoint[];
  currentPosition: FrontierPoint;
  candidateAdjustments: Array<{
    name: string;
    position: FrontierPoint;
  }>;
}

export class EfficiencyFrontierService {
  /**
   * Computes points on the efficient frontier for a set of strategies.
   */
  computeFrontier(strategyIds: string[]): FrontierPoint[] {
    const protocols = PROTOCOLS.filter(p => strategyIds.includes(p.protocolName.toLowerCase()));
    
    // Simplified Markowitz optimization:
    // We generate a set of portfolios by mixing the strategies.
    // In a real app, this would use a quadratic solver.
    const points: FrontierPoint[] = [];
    
    // 1. Single strategy points
    protocols.forEach(p => {
      points.push({
        risk: p.volatilityPct,
        return: p.baseApyBps / 100,
        allocation: { [p.protocolName.toLowerCase()]: 100 }
      });
    });

    // 2. 50/50 mix points (Simplified frontier)
    for (let i = 0; i < protocols.length; i++) {
      for (let j = i + 1; j < protocols.length; j++) {
        const p1 = protocols[i];
        const p2 = protocols[j];
        
        // Return is linear
        const avgReturn = ((p1.baseApyBps / 100) + (p2.baseApyBps / 100)) / 2;
        // Risk is NOT linear (diversification benefit), simplified here as 0.85 * avg
        const avgRisk = ((p1.volatilityPct + p2.volatilityPct) / 2) * 0.85;
        
        points.push({
          risk: Math.round(avgRisk * 100) / 100,
          return: Math.round(avgReturn * 100) / 100,
          allocation: {
            [p1.protocolName.toLowerCase()]: 50,
            [p2.protocolName.toLowerCase()]: 50
          }
        });
      }
    }

    // Sort by risk to form the curve
    return points.sort((a, b) => a.risk - b.risk);
  }

  /**
   * Calculates the shift in position for a candidate adjustment.
   */
  calculateShift(currentAllocation: Record<string, number>, adjustment: Record<string, number>): FrontierPoint {
    const newAllocation = { ...currentAllocation };
    for (const [id, pct] of Object.entries(adjustment)) {
      newAllocation[id] = (newAllocation[id] || 0) + pct;
    }

    // Normalize
    const total = Object.values(newAllocation).reduce((a, b) => a + b, 0);
    for (const id in newAllocation) {
      newAllocation[id] = (newAllocation[id] / total) * 100;
    }

    let totalReturn = 0;
    let totalRisk = 0;
    
    for (const [id, pct] of Object.entries(newAllocation)) {
      const p = PROTOCOLS.find(p => p.protocolName.toLowerCase() === id);
      if (p) {
        totalReturn += (p.baseApyBps / 100) * (pct / 100);
        totalRisk += p.volatilityPct * (pct / 100); // Simplified risk aggregation
      }
    }

    return {
      risk: Math.round(totalRisk * 100) / 100,
      return: Math.round(totalReturn * 100) / 100,
      allocation: newAllocation
    };
  }
}

export const efficiencyFrontierService = new EfficiencyFrontierService();
