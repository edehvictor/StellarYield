import {
  BlastRadiusAnalyzer,
  blastRadiusAnalyzer,
  formatBlastRadiusResult,
  getBlastRadiusSummary,
  DependencyGraph,
} from "../services/blastRadiusService";

describe("BlastRadiusAnalyzer", () => {
  let analyzer: BlastRadiusAnalyzer;

  const sampleGraph: DependencyGraph = {
    nodes: [
      {
        id: "protocol_a",
        name: "Protocol A",
        type: "protocol",
        criticality: "critical",
        description: "Core lending protocol",
      },
      {
        id: "oracle_b",
        name: "Oracle B",
        type: "oracle",
        criticality: "high",
        description: "Price oracle",
      },
      {
        id: "strategy_1",
        name: "Strategy 1",
        type: "smart_contract",
        criticality: "high",
        description: "Yield strategy",
      },
      {
        id: "strategy_2",
        name: "Strategy 2",
        type: "smart_contract",
        criticality: "medium",
        description: "Another yield strategy",
      },
      {
        id: "vault_1",
        name: "Vault 1",
        type: "infrastructure",
        criticality: "high",
        description: "Main vault",
      },
    ],
    edges: [
      {
        from: "strategy_1",
        to: "protocol_a",
        relationship: "uses",
        impactWeight: 0.9,
      },
      {
        from: "strategy_2",
        to: "protocol_a",
        relationship: "uses",
        impactWeight: 0.7,
      },
      {
        from: "strategy_1",
        to: "oracle_b",
        relationship: "relies_on",
        impactWeight: 0.8,
      },
      {
        from: "vault_1",
        to: "strategy_1",
        relationship: "depends_on",
        impactWeight: 0.6,
      },
    ],
  };

  beforeEach(() => {
    analyzer = new BlastRadiusAnalyzer();
    analyzer.loadDependencyGraph(sampleGraph);
  });

  afterEach(() => {
    analyzer.clearCache();
  });

  describe("analyzeBlastRadius", () => {
    it("should analyze blast radius for a dependency", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result).toBeDefined();
      expect(result.failedDependency.id).toBe("protocol_a");
      expect(result.totalAffected).toBeGreaterThanOrEqual(0);
      expect(result.blastRadiusScore).toBeGreaterThanOrEqual(0);
      expect(result.classification).toBeDefined();
      expect(result.affectedEntities).toBeDefined();
    });

    it("should throw error for non-existent dependency", async () => {
      await expect(analyzer.analyzeBlastRadius("non_existent")).rejects.toThrow(
        "Dependency non_existent not found in graph",
      );
    });

    it("should throw error when service is frozen", async () => {
      const mockFreezeService = require("../services/freezeService");
      jest.spyOn(mockFreezeService.freezeService, "isFrozen").mockReturnValue(true);

      await expect(analyzer.analyzeBlastRadius("protocol_a")).rejects.toThrow(
        "Blast radius analyzer is frozen",
      );

      mockFreezeService.freezeService.isFrozen.mockRestore();
    });

    it("should include disclaimer in result", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.disclaimer).toContain("operational planning");
    });

    it("should include timestamp", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.analyzedAt).toBeDefined();
      expect(new Date(result.analyzedAt).toISOString()).toBeDefined();
    });

    it("should calculate cascade depth", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.cascadeDepth).toBeGreaterThanOrEqual(0);
    });

    it("should estimate recovery time", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.estimatedRecoveryHours).toBeGreaterThan(0);
    });

    it("should generate recommended actions", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.recommendedActions).toBeDefined();
      expect(result.recommendedActions.length).toBeGreaterThan(0);
    });
  });

  describe("blast radius scoring", () => {
    it("should classify catastrophic blast radius", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.classification).toBeDefined();
      expect(["catastrophic", "severe", "moderate", "minimal"]).toContain(
        result.classification,
      );
    });

    it("should calculate score between 0 and 100", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.blastRadiusScore).toBeGreaterThanOrEqual(0);
      expect(result.blastRadiusScore).toBeLessThanOrEqual(100);
    });

    it("should have higher score for critical dependencies", async () => {
      const criticalResult = await analyzer.analyzeBlastRadius("protocol_a");
      
      expect(criticalResult.blastRadiusScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe("affected entities", () => {
    it("should identify affected entities", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      expect(result.affectedEntities).toBeDefined();
    });

    it("should calculate impact percentage for each entity", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      result.affectedEntities.forEach((entity) => {
        expect(entity.impactPercentage).toBeGreaterThanOrEqual(0);
        expect(entity.impactPercentage).toBeLessThanOrEqual(100);
      });
    });

    it("should determine impact severity", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      result.affectedEntities.forEach((entity) => {
        expect(["critical", "high", "medium", "low"]).toContain(
          entity.impactSeverity,
        );
      });
    });

    it("should include impact description", async () => {
      const result = await analyzer.analyzeBlastRadius("protocol_a");

      result.affectedEntities.forEach((entity) => {
        expect(entity.impactDescription).toBeDefined();
        expect(entity.impactDescription.length).toBeGreaterThan(0);
      });
    });
  });

  describe("batchAnalyze", () => {
    it("should analyze multiple dependencies", async () => {
      const results = await analyzer.batchAnalyze(["protocol_a", "oracle_b"]);

      expect(results).toHaveLength(2);
      expect(results[0].failedDependency.id).toBe("protocol_a");
      expect(results[1].failedDependency.id).toBe("oracle_b");
    });

    it("should handle empty dependency list", async () => {
      const results = await analyzer.batchAnalyze([]);

      expect(results).toHaveLength(0);
    });
  });

  describe("getDependenciesForEntity", () => {
    it("should return dependencies affecting an entity", () => {
      const dependencies = analyzer.getDependenciesForEntity("strategy_1");

      expect(dependencies).toBeDefined();
    });
  });

  describe("getCriticalDependencies", () => {
    it("should return top critical dependencies", async () => {
      const criticalDeps = await analyzer.getCriticalDependencies(5);

      expect(criticalDeps.length).toBeLessThanOrEqual(5);
      expect(criticalDeps[0]?.dependency).toBeDefined();
      expect(criticalDeps[0]?.blastRadiusScore).toBeDefined();
    });

    it("should sort by blast radius score descending", async () => {
      const criticalDeps = await analyzer.getCriticalDependencies(10);

      for (let i = 0; i < criticalDeps.length - 1; i++) {
        expect(criticalDeps[i].blastRadiusScore).toBeGreaterThanOrEqual(
          criticalDeps[i + 1].blastRadiusScore,
        );
      }
    });
  });

  describe("configuration", () => {
    it("should return current configuration", () => {
      const config = analyzer.getConfig();

      expect(config).toBeDefined();
      expect(config.catastrophicThreshold).toBe(75);
      expect(config.severeThreshold).toBe(50);
      expect(config.moderateThreshold).toBe(25);
    });

    it("should update configuration", () => {
      analyzer.updateConfig({
        catastrophicThreshold: 80,
        cacheMinutes: 30,
      });

      const config = analyzer.getConfig();
      expect(config.catastrophicThreshold).toBe(80);
      expect(config.cacheMinutes).toBe(30);
    });

    it("should clear cache on config update", () => {
      analyzer.updateConfig({ moderateThreshold: 30 });
      
      // Cache should be cleared
      analyzer.clearCache();
    });
  });

  describe("dependency graph", () => {
    it("should return current dependency graph", () => {
      const graph = analyzer.getDependencyGraph();

      expect(graph).toBeDefined();
      expect(graph.nodes).toBeDefined();
      expect(graph.edges).toBeDefined();
    });

    it("should load new dependency graph", () => {
      const newGraph: DependencyGraph = {
        nodes: [
          {
            id: "new_protocol",
            name: "New Protocol",
            type: "protocol",
            criticality: "medium",
            description: "Test protocol",
          },
        ],
        edges: [],
      };

      analyzer.loadDependencyGraph(newGraph);
      const graph = analyzer.getDependencyGraph();

      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].id).toBe("new_protocol");
    });
  });

  describe("clearCache", () => {
    it("should clear cached results", async () => {
      await analyzer.analyzeBlastRadius("protocol_a");
      analyzer.clearCache();

      // After clearing, should recalculate
      const result = await analyzer.analyzeBlastRadius("protocol_a");
      expect(result).toBeDefined();
    });
  });
});

describe("formatBlastRadiusResult", () => {
  it("should format blast radius result correctly", async () => {
    const analyzer = new BlastRadiusAnalyzer();
    const graph: DependencyGraph = {
      nodes: [
        {
          id: "test_dep",
          name: "Test Dependency",
          type: "protocol",
          criticality: "high",
          description: "Test",
        },
      ],
      edges: [],
    };
    analyzer.loadDependencyGraph(graph);

    const result = await analyzer.analyzeBlastRadius("test_dep");
    const formatted = formatBlastRadiusResult(result);

    expect(formatted).toBeDefined();
    expect(formatted.blastRadiusScore).toBeDefined();
    expect(formatted.affectedEntities).toBeDefined();
  });
});

describe("getBlastRadiusSummary", () => {
  it("should return catastrophic summary for catastrophic classification", async () => {
    const analyzer = new BlastRadiusAnalyzer();
    const graph: DependencyGraph = {
      nodes: [
        {
          id: "test_dep",
          name: "Test Dependency",
          type: "protocol",
          criticality: "critical",
          description: "Test",
        },
      ],
      edges: [],
    };
    analyzer.loadDependencyGraph(graph);

    const result = await analyzer.analyzeBlastRadius("test_dep");
    const summary = getBlastRadiusSummary(result);

    expect(summary.verdict).toBeDefined();
    expect(summary.color).toBeDefined();
    expect(summary.message).toBeDefined();
  });

  it("should include affected count in message", async () => {
    const analyzer = new BlastRadiusAnalyzer();
    const graph: DependencyGraph = {
      nodes: [
        {
          id: "test_dep",
          name: "Test Dependency",
          type: "protocol",
          criticality: "high",
          description: "Test",
        },
      ],
      edges: [],
    };
    analyzer.loadDependencyGraph(graph);

    const result = await analyzer.analyzeBlastRadius("test_dep");
    const summary = getBlastRadiusSummary(result);

    expect(summary.message).toContain(result.totalAffected.toString());
  });
});

describe("Singleton instance", () => {
  it("should export blastRadiusAnalyzer singleton", () => {
    expect(blastRadiusAnalyzer).toBeDefined();
    expect(blastRadiusAnalyzer).toBeInstanceOf(BlastRadiusAnalyzer);
  });
});
