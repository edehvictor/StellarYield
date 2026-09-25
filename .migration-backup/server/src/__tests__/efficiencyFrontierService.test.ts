import { efficiencyFrontierService } from "../services/efficiencyFrontierService";

describe("EfficiencyFrontierService", () => {
  it("should compute a frontier for a set of strategy IDs", () => {
    const strategyIds = ["blend", "soroswap"];
    const frontier = efficiencyFrontierService.computeFrontier(strategyIds);

    expect(Array.isArray(frontier)).toBe(true);
    expect(frontier.length).toBeGreaterThan(0);
    
    // Each point should have risk, return, and allocation
    frontier.forEach(point => {
      expect(point.risk).toBeDefined();
      expect(point.return).toBeDefined();
      expect(point.allocation).toBeDefined();
      
      const totalAlloc = Object.values(point.allocation).reduce((a, b) => a + b, 0);
      expect(totalAlloc).toBeCloseTo(100, 1);
    });

    // Should be sorted by risk
    for (let i = 1; i < frontier.length; i++) {
      expect(frontier[i].risk).toBeGreaterThanOrEqual(frontier[i-1].risk);
    }
  });

  it("should calculate shift correctly for an adjustment", () => {
    const currentAllocation = { blend: 100 };
    const adjustment = { soroswap: 50 }; // Add 50 units of soroswap
    
    const result = efficiencyFrontierService.calculateShift(currentAllocation, adjustment);
    
    expect(result.risk).toBeDefined();
    expect(result.return).toBeDefined();
    
    // Result allocation should have both
    expect(result.allocation.blend).toBeDefined();
    expect(result.allocation.soroswap).toBeDefined();
    
    // New total should be 100%
    const totalAlloc = Object.values(result.allocation).reduce((a, b) => a + b, 0);
    expect(totalAlloc).toBeCloseTo(100, 1);
  });
});
