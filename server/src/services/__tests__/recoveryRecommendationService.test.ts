import { RecoveryRecommendationService, ShockEvent } from "../recoveryRecommendationService";

describe("RecoveryRecommendationService", () => {
  const mockVaultId = "test-vault";
  const mockProtocol = "TestProtocol";

  const mockPassingGuardrails = {
    evaluateGuardrails: () => ({ passed: true, blockedRules: [], warnings: [] })
  };

  const service = new RecoveryRecommendationService(mockPassingGuardrails);

  it("should recommend ROTATE for CRITICAL APY crash", async () => {
    const event: ShockEvent = {
      type: "APY_CRASH",
      severity: "CRITICAL",
      vaultId: mockVaultId,
      protocol: mockProtocol,
      description: "APY dropped to 0%",
      timestamp: Date.now(),
    };

    const recommendations = await service.evaluateRecoveryOptions(event);
    
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].path).toBe("ROTATE");
    expect(recommendations[0].riskLevel).toBe("MEDIUM");
  });

  it("should recommend HOLD and REBALANCE for LOW APY crash", async () => {
    const event: ShockEvent = {
      type: "APY_CRASH",
      severity: "LOW",
      vaultId: mockVaultId,
      protocol: mockProtocol,
      description: "Minor APY dip",
      timestamp: Date.now(),
    };

    const recommendations = await service.evaluateRecoveryOptions(event);
    
    expect(recommendations).toHaveLength(2);
    expect(recommendations.map(r => r.path)).toContain("HOLD");
    expect(recommendations.map(r => r.path)).toContain("REBALANCE");
  });

  it("should recommend UNWIND for ORACLE_ANOMALY regardless of severity", async () => {
    const event: ShockEvent = {
      type: "ORACLE_ANOMALY",
      severity: "LOW",
      vaultId: mockVaultId,
      protocol: mockProtocol,
      description: "Stale price feed",
      timestamp: Date.now(),
    };

    const recommendations = await service.evaluateRecoveryOptions(event);
    
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].path).toBe("UNWIND");
    expect(recommendations[0].riskLevel).toBe("HIGH");
  });

  it("should recommend UNWIND for HIGH severity LIQUIDITY_EVENT", async () => {
    const event: ShockEvent = {
      type: "LIQUIDITY_EVENT",
      severity: "HIGH",
      vaultId: mockVaultId,
      protocol: mockProtocol,
      description: "Pool liquidity drained",
      timestamp: Date.now(),
    };

    const recommendations = await service.evaluateRecoveryOptions(event);
    
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].path).toBe("UNWIND");
    expect(recommendations[0].riskLevel).toBe("HIGH");
  });

  it("should recommend REBALANCE for LOW severity LIQUIDITY_EVENT", async () => {
    const event: ShockEvent = {
      type: "LIQUIDITY_EVENT",
      severity: "LOW",
      vaultId: mockVaultId,
      protocol: mockProtocol,
      description: "Slight liquidity dip",
      timestamp: Date.now(),
    };

    const recommendations = await service.evaluateRecoveryOptions(event);
    
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].path).toBe("REBALANCE");
    expect(recommendations[0].riskLevel).toBe("MEDIUM");
  });

  it("should return default HOLD recommendation for unknown event types", async () => {
    const event: any = {
      type: "UNKNOWN_EVENT",
      severity: "MEDIUM",
      vaultId: mockVaultId,
      protocol: mockProtocol,
      description: "Something happened",
      timestamp: Date.now(),
    };

    const recommendations = await service.evaluateRecoveryOptions(event);
    
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].path).toBe("HOLD");
  });

  it("should recommend ROTATE when health check fails even for LOW severity", async () => {
    const mockFailingGuardrails = {
      evaluateGuardrails: () => ({ passed: false, blockedRules: [], warnings: ["Health failed"] })
    };
    const failingService = new RecoveryRecommendationService(mockFailingGuardrails);

    const event: ShockEvent = {
      type: "APY_CRASH",
      severity: "LOW",
      vaultId: mockVaultId,
      protocol: mockProtocol,
      description: "Minor dip but health failed",
      timestamp: Date.now(),
    };

    const recommendations = await failingService.evaluateRecoveryOptions(event);
    
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].path).toBe("ROTATE");
  });
});
