import {
  StrategyStateTransitionAuditService,
  type StrategyLifecycleState,
} from "../strategyStateTransitionAuditService";

describe("StrategyStateTransitionAuditService (#371)", () => {
  let service: StrategyStateTransitionAuditService;

  beforeEach(() => {
    service = new StrategyStateTransitionAuditService();
    service.reset();
  });

  it("stores initial state without creating a synthetic edge", () => {
    const rec = service.recordTransition("s1", "healthy", {
      type: "health",
      condition: "initial",
    });
    expect(rec).toBeNull();
    expect(service.getLastState("s1")).toBe("healthy");
  });

  it("records a valid chain of transitions and produces graph nodes/edges", () => {
    service.recordTransition(
      "s1",
      "frozen",
      { type: "operator", condition: "freeze_reason=maintenance", operator: "admin" },
      { fromStateOverride: "degraded" as StrategyLifecycleState },
    );
    service.recordTransition("s1", "recovered", { type: "operator", condition: "resume_reason=operator" });
    service.recordTransition("s1", "healthy", { type: "health", condition: "health_status=healthy" });

    const graph = service.getGraph("s1", 10);
    expect(graph.nodes.length).toBe(4);
    expect(graph.edges.length).toBe(3);
    expect(graph.edges[0].label).toContain("Degraded");
    expect(graph.edges[2].label).toContain("Recovered");
  });

  it("rejects invalid transition frozen -> healthy", () => {
    expect(() =>
      service.recordTransition(
        "s1",
        "healthy",
        { type: "health", condition: "health_status=healthy" },
        { fromStateOverride: "frozen" as StrategyLifecycleState },
      ),
    ).toThrow(/Invalid lifecycle transition/);
  });
});

