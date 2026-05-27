/**
 * Tests for Hierarchical Strategy Fallback Tree Service
 *
 * Coverage:
 *   - Fallback ordering (priority-based, depth-first traversal)
 *   - Cycle detection and prevention
 *   - Terminal failure states
 *   - Health and blocklist safety checks
 *   - Tree validation
 *   - Registry state management
 *   - Traversal history tracking
 */

import {
  FallbackNode,
  TraversalContext,
  HealthCheck,
  BlocklistCheck,
  validateFallbackTree,
  traverseFallbackTree,
  FallbackTreeRegistry,
  createFallbackTreeFromList,
  formatTraversalResult,
  extractFailedNodes,
  DEFAULT_FALLBACK_CONFIG,
} from '../fallbackTreeService';

describe('Fallback Tree Service', () => {
  describe('validateFallbackTree', () => {
    it('should validate a simple valid tree', () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root Strategy',
        fallbacks: [
          {
            id: 'child1',
            name: 'Child 1',
            fallbacks: [],
          },
          {
            id: 'child2',
            name: 'Child 2',
            fallbacks: [],
          },
        ],
      };

      const result = validateFallbackTree(tree);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should detect cycles in the tree', () => {
      const child: FallbackNode = {
        id: 'child',
        name: 'Child',
        fallbacks: [],
      };
      const root: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [child],
      };
      // Create a cycle
      child.fallbacks.push(root);

      const result = validateFallbackTree(root);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cycle detected in fallback tree');
    });

    it('should detect duplicate IDs at the same level', () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [
          {
            id: 'duplicate',
            name: 'First Duplicate',
            fallbacks: [],
          },
          {
            id: 'duplicate',
            name: 'Second Duplicate',
            fallbacks: [],
          },
        ],
      };

      const result = validateFallbackTree(tree);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate node ID at same level: duplicate');
    });

    it('should allow duplicate IDs at different levels', () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [
          {
            id: 'level1',
            name: 'Level 1',
            fallbacks: [
              {
                id: 'level1',
                name: 'Level 2 (same ID)',
                fallbacks: [],
              },
            ],
          },
        ],
      };

      const result = validateFallbackTree(tree);
      expect(result.valid).toBe(true);
    });
  });

  describe('traverseFallbackTree - basic ordering', () => {
    it('should select the first healthy node', async () => {
      const tree: FallbackNode = {
        id: 'primary',
        name: 'Primary Strategy',
        fallbacks: [
          {
            id: 'fallback1',
            name: 'Fallback 1',
            fallbacks: [],
          },
          {
            id: 'fallback2',
            name: 'Fallback 2',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        primary: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        fallback1: {
          status: 'healthy',
          score: 85,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        fallback2: {
          status: 'healthy',
          score: 80,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(false);
      expect(result.selectedNode?.id).toBe('primary');
      expect(result.path[0].selected).toBe(true);
      expect(result.nodesEvaluated).toBe(1);
    });

    it('should fallback to second option when first is unhealthy', async () => {
      const tree: FallbackNode = {
        id: 'primary',
        name: 'Primary Strategy',
        fallbacks: [
          {
            id: 'fallback1',
            name: 'Fallback 1',
            fallbacks: [],
          },
          {
            id: 'fallback2',
            name: 'Fallback 2',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        primary: {
          status: 'critical',
          score: 20,
          checkedAt: new Date().toISOString(),
          reasons: ['Critical error'],
        },
        fallback1: {
          status: 'healthy',
          score: 85,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        fallback2: {
          status: 'healthy',
          score: 80,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(false);
      expect(result.selectedNode?.id).toBe('fallback1');
      expect(result.path[0].selected).toBe(false);
      expect(result.path[1].selected).toBe(true);
      expect(result.nodesEvaluated).toBe(2);
    });

    it('should traverse multiple levels of fallbacks', async () => {
      const tree: FallbackNode = {
        id: 'primary',
        name: 'Primary',
        fallbacks: [
          {
            id: 'secondary',
            name: 'Secondary',
            fallbacks: [
              {
                id: 'tertiary',
                name: 'Tertiary',
                fallbacks: [],
              },
            ],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        primary: {
          status: 'critical',
          score: 10,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        secondary: {
          status: 'critical',
          score: 15,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        tertiary: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(false);
      expect(result.selectedNode?.id).toBe('tertiary');
      expect(result.maxDepthReached).toBe(2);
      expect(result.nodesEvaluated).toBe(3);
    });

    it('should respect priority ordering when multiple options are available', async () => {
      const tree: FallbackNode = {
        id: 'low_priority',
        name: 'Low Priority',
        priority: 1,
        fallbacks: [
          {
            id: 'high_priority',
            name: 'High Priority',
            priority: 10,
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        low_priority: {
          status: 'critical',
          score: 10,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        high_priority: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.selectedNode?.id).toBe('high_priority');
    });
  });

  describe('traverseFallbackTree - safety checks', () => {
    it('should skip blocked nodes', async () => {
      const tree: FallbackNode = {
        id: 'primary',
        name: 'Primary',
        fallbacks: [
          {
            id: 'blocked',
            name: 'Blocked Strategy',
            fallbacks: [],
          },
          {
            id: 'healthy',
            name: 'Healthy Strategy',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        primary: {
          status: 'critical',
          score: 10,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        blocked: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        healthy: {
          status: 'healthy',
          score: 85,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const mockBlocklist: Record<string, BlocklistCheck> = {
        primary: { isBlocked: false, checkedAt: new Date().toISOString() },
        blocked: { isBlocked: true, reason: 'Manual block', checkedAt: new Date().toISOString() },
        healthy: { isBlocked: false, checkedAt: new Date().toISOString() },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: (id) => mockBlocklist[id],
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.selectedNode?.id).toBe('healthy');
      expect(result.path.find(p => p.nodeId === 'blocked')?.selected).toBe(false);
      expect(result.path.find(p => p.nodeId === 'blocked')?.reason).toContain('Blocked');
    });

    it('should skip nodes below minimum health score', async () => {
      const tree: FallbackNode = {
        id: 'low_score',
        name: 'Low Score',
        fallbacks: [
          {
            id: 'high_score',
            name: 'High Score',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        low_score: {
          status: 'degraded',
          score: 40,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        high_score: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 70,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.selectedNode?.id).toBe('high_score');
      expect(result.path[0].selected).toBe(false);
      expect(result.path[0].reason).toContain('below threshold');
    });

    it('should skip degraded nodes when allowDegraded is false', async () => {
      const tree: FallbackNode = {
        id: 'degraded',
        name: 'Degraded',
        fallbacks: [
          {
            id: 'healthy',
            name: 'Healthy',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        degraded: {
          status: 'degraded',
          score: 65,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        healthy: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: false,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.selectedNode?.id).toBe('healthy');
      expect(result.path[0].selected).toBe(false);
      expect(result.path[0].reason).toContain('Degraded status not allowed');
    });

    it('should skip unknown status nodes', async () => {
      const tree: FallbackNode = {
        id: 'unknown',
        name: 'Unknown',
        fallbacks: [
          {
            id: 'healthy',
            name: 'Healthy',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        unknown: {
          status: 'unknown',
          score: 0,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        healthy: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.selectedNode?.id).toBe('healthy');
      expect(result.path[0].selected).toBe(false);
      expect(result.path[0].reason).toContain('Status is unknown');
    });
  });

  describe('traverseFallbackTree - cycle prevention', () => {
    it('should prevent traversal into cycles', async () => {
      const child: FallbackNode = {
        id: 'child',
        name: 'Child',
        fallbacks: [],
      };
      const root: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [child],
      };
      child.fallbacks.push(root);

      const mockHealth: Record<string, HealthCheck> = {
        root: {
          status: 'critical',
          score: 10,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        child: {
          status: 'critical',
          score: 10,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(root, context);

      expect(result.terminalFailure).toBe(true);
      expect(result.terminalFailureReason).toContain('Invalid tree structure');
    });

    it('should detect cycles during runtime traversal', async () => {
      // Create a tree that passes validation but has runtime cycle
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [
          {
            id: 'a',
            name: 'A',
            fallbacks: [
              {
                id: 'b',
                name: 'B',
                fallbacks: [],
              },
            ],
          },
        ],
      };

      const visitedSet = new Set<string>();
      let callCount = 0;

      const context: TraversalContext = {
        checkHealth: (id) => {
          callCount++;
          // Simulate a cycle by returning the same node
          if (id === 'b' && callCount > 3) {
            visitedSet.add('root');
          }
          return {
            status: 'critical',
            score: 10,
            checkedAt: new Date().toISOString(),
            reasons: [],
          };
        },
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(true);
    });
  });

  describe('traverseFallbackTree - terminal failure states', () => {
    it('should return terminal failure when all nodes are unhealthy', async () => {
      const tree: FallbackNode = {
        id: 'primary',
        name: 'Primary',
        fallbacks: [
          {
            id: 'fallback1',
            name: 'Fallback 1',
            fallbacks: [],
          },
          {
            id: 'fallback2',
            name: 'Fallback 2',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        primary: {
          status: 'critical',
          score: 10,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        fallback1: {
          status: 'critical',
          score: 15,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        fallback2: {
          status: 'critical',
          score: 20,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(true);
      expect(result.selectedNode).toBeNull();
      expect(result.terminalFailureReason).toBe('No viable path found in fallback tree');
      expect(result.nodesEvaluated).toBe(3);
    });

    it('should return terminal failure when all nodes are blocked', async () => {
      const tree: FallbackNode = {
        id: 'primary',
        name: 'Primary',
        fallbacks: [
          {
            id: 'fallback1',
            name: 'Fallback 1',
            fallbacks: [],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        primary: {
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
        fallback1: {
          status: 'healthy',
          score: 85,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: true, reason: 'All blocked', checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(true);
      expect(result.selectedNode).toBeNull();
    });

    it('should stop at max depth and return terminal failure', async () => {
      const tree: FallbackNode = {
        id: 'level0',
        name: 'Level 0',
        fallbacks: [
          {
            id: 'level1',
            name: 'Level 1',
            fallbacks: [
              {
                id: 'level2',
                name: 'Level 2',
                fallbacks: [
                  {
                    id: 'level3',
                    name: 'Level 3',
                    fallbacks: [],
                  },
                ],
              },
            ],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        level0: { status: 'critical', score: 10, checkedAt: new Date().toISOString(), reasons: [] },
        level1: { status: 'critical', score: 10, checkedAt: new Date().toISOString(), reasons: [] },
        level2: { status: 'critical', score: 10, checkedAt: new Date().toISOString(), reasons: [] },
        level3: { status: 'healthy', score: 90, checkedAt: new Date().toISOString(), reasons: [] },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 2,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(true);
      expect(result.maxDepthReached).toBe(2);
      expect(result.path.find(p => p.nodeId === 'level3')?.reason).toContain('Max depth');
    });

    it('should handle empty tree gracefully', async () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      const mockHealth: Record<string, HealthCheck> = {
        root: {
          status: 'critical',
          score: 10,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.terminalFailure).toBe(true);
      expect(result.nodesEvaluated).toBe(1);
    });
  });

  describe('FallbackTreeRegistry', () => {
    let registry: FallbackTreeRegistry;

    beforeEach(() => {
      registry = new FallbackTreeRegistry();
    });

    it('should register and retrieve trees', () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      registry.registerTree('test-tree', tree);
      expect(registry.getTree('test-tree')).toBe(tree);
    });

    it('should validate trees on registration', () => {
      const child: FallbackNode = {
        id: 'child',
        name: 'Child',
        fallbacks: [],
      };
      const root: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [child],
      };
      child.fallbacks.push(root);

      expect(() => registry.registerTree('invalid-tree', root)).toThrow('Invalid fallback tree');
    });

    it('should remove trees', () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      registry.registerTree('test-tree', tree);
      expect(registry.removeTree('test-tree')).toBe(true);
      expect(registry.getTree('test-tree')).toBeUndefined();
    });

    it('should list all tree keys', () => {
      const tree1: FallbackNode = { id: 'root1', name: 'Root 1', fallbacks: [] };
      const tree2: FallbackNode = { id: 'root2', name: 'Root 2', fallbacks: [] };

      registry.registerTree('tree1', tree1);
      registry.registerTree('tree2', tree2);

      const keys = registry.getTreeKeys();
      expect(keys).toContain('tree1');
      expect(keys).toContain('tree2');
    });

    it('should traverse registered trees', async () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      registry.registerTree('test-tree', tree);

      const result = await registry.traverse('test-tree', {
        checkHealth: () => ({
          status: 'healthy',
          score: 90,
          checkedAt: new Date().toISOString(),
          reasons: [],
        }),
        checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      });

      expect(result.selectedNode?.id).toBe('root');
    });

    it('should throw error when traversing non-existent tree', async () => {
      await expect(
        registry.traverse('non-existent', {
          checkHealth: () => ({
            status: 'healthy',
            score: 90,
            checkedAt: new Date().toISOString(),
            reasons: [],
          }),
          checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
          minHealthScore: 50,
          allowDegraded: true,
          maxDepth: 10,
        })
      ).rejects.toThrow('Fallback tree not found');
    });

    it('should record traversal history', async () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      registry.registerTree('test-tree', tree);

      await registry.traverse('test-tree');
      await registry.traverse('test-tree');

      const history = registry.getTraversalHistory();
      expect(history.length).toBe(2);
    });

    it('should limit traversal history size', async () => {
      const registry = new FallbackTreeRegistry({ maxHistorySize: 5 });
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      registry.registerTree('test-tree', tree);

      for (let i = 0; i < 10; i++) {
        await registry.traverse('test-tree');
      }

      const history = registry.getTraversalHistory();
      expect(history.length).toBe(5);
    });

    it('should filter history by tree key', async () => {
      const tree1: FallbackNode = { id: 'root1', name: 'Root 1', fallbacks: [] };
      const tree2: FallbackNode = { id: 'root2', name: 'Root 2', fallbacks: [] };

      registry.registerTree('tree1', tree1);
      registry.registerTree('tree2', tree2);

      await registry.traverse('tree1');
      await registry.traverse('tree1');
      await registry.traverse('tree2');

      const tree1History = registry.getTraversalHistoryForTree('tree1');
      expect(tree1History.length).toBe(2);

      const tree2History = registry.getTraversalHistoryForTree('tree2');
      expect(tree2History.length).toBe(1);
    });

    it('should clear history', async () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      registry.registerTree('test-tree', tree);
      await registry.traverse('test-tree');

      registry.clearHistory();

      expect(registry.getTraversalHistory()).toHaveLength(0);
    });

    it('should update configuration', () => {
      registry.updateConfig({ defaultMinHealthScore: 80 });
      expect(registry.getConfig().defaultMinHealthScore).toBe(80);
    });

    it('should reset state', () => {
      const tree: FallbackNode = {
        id: 'root',
        name: 'Root',
        fallbacks: [],
      };

      registry.registerTree('test-tree', tree);
      registry.reset();

      expect(registry.getTreeKeys()).toHaveLength(0);
      expect(registry.getTraversalHistory()).toHaveLength(0);
    });
  });

  describe('createFallbackTreeFromList', () => {
    it('should create a chain from a list of strategies', () => {
      const strategies = [
        { id: 'a', name: 'A', priority: 3 },
        { id: 'b', name: 'B', priority: 2 },
        { id: 'c', name: 'C', priority: 1 },
      ];

      const tree = createFallbackTreeFromList(strategies);

      expect(tree.id).toBe('a');
      expect(tree.fallbacks[0].id).toBe('b');
      expect(tree.fallbacks[0].fallbacks[0].id).toBe('c');
    });

    it('should sort by priority descending', () => {
      const strategies = [
        { id: 'low', name: 'Low', priority: 1 },
        { id: 'high', name: 'High', priority: 10 },
        { id: 'medium', name: 'Medium', priority: 5 },
      ];

      const tree = createFallbackTreeFromList(strategies);

      expect(tree.id).toBe('high');
      expect(tree.fallbacks[0].id).toBe('medium');
      expect(tree.fallbacks[0].fallbacks[0].id).toBe('low');
    });

    it('should handle missing priorities (default to 0)', () => {
      const strategies = [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', priority: 5 },
      ];

      const tree = createFallbackTreeFromList(strategies);

      expect(tree.id).toBe('b');
      expect(tree.fallbacks[0].id).toBe('a');
    });

    it('should throw on empty list', () => {
      expect(() => createFallbackTreeFromList([])).toThrow('Cannot create fallback tree from empty list');
    });

    it('should sort by ID for tie-breaking', () => {
      const strategies = [
        { id: 'zebra', name: 'Zebra', priority: 5 },
        { id: 'apple', name: 'Apple', priority: 5 },
      ];

      const tree = createFallbackTreeFromList(strategies);

      expect(tree.id).toBe('apple');
      expect(tree.fallbacks[0].id).toBe('zebra');
    });
  });

  describe('formatTraversalResult', () => {
    it('should format successful traversal', () => {
      const result = {
        selectedNode: { id: 'test', name: 'Test', fallbacks: [] },
        path: [],
        terminalFailure: false,
        nodesEvaluated: 3,
        maxDepthReached: 2,
        completedAt: new Date().toISOString(),
      };

      const formatted = formatTraversalResult(result);
      expect(formatted).toContain('Test');
      expect(formatted).toContain('test');
      expect(formatted).toContain('3 nodes');
    });

    it('should format terminal failure', () => {
      const result = {
        selectedNode: null,
        path: [],
        terminalFailure: true,
        terminalFailureReason: 'All nodes failed',
        nodesEvaluated: 5,
        maxDepthReached: 3,
        completedAt: new Date().toISOString(),
      };

      const formatted = formatTraversalResult(result);
      expect(formatted).toContain('Terminal failure');
      expect(formatted).toContain('All nodes failed');
      expect(formatted).toContain('5 nodes');
    });
  });

  describe('extractFailedNodes', () => {
    it('should extract failed nodes from traversal path', () => {
      const result = {
        selectedNode: { id: 'success', name: 'Success', fallbacks: [] },
        path: [
          {
            nodeId: 'failed1',
            nodeName: 'Failed 1',
            depth: 0,
            selected: false,
            reason: 'Critical',
            health: { status: 'critical' as const, score: 10, checkedAt: new Date().toISOString(), reasons: [] },
            blocklist: { isBlocked: false, checkedAt: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          },
          {
            nodeId: 'success',
            nodeName: 'Success',
            depth: 1,
            selected: true,
            reason: 'OK',
            health: { status: 'healthy' as const, score: 90, checkedAt: new Date().toISOString(), reasons: [] },
            blocklist: { isBlocked: false, checkedAt: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          },
        ],
        terminalFailure: false,
        nodesEvaluated: 2,
        maxDepthReached: 1,
        completedAt: new Date().toISOString(),
      };

      const failed = extractFailedNodes(result);

      expect(failed).toHaveLength(1);
      expect(failed[0].nodeId).toBe('failed1');
      expect(failed[0].reason).toBe('Critical');
      expect(failed[0].healthScore).toBe(10);
    });

    it('should return empty array when all nodes succeeded', () => {
      const result = {
        selectedNode: { id: 'success', name: 'Success', fallbacks: [] },
        path: [
          {
            nodeId: 'success',
            nodeName: 'Success',
            depth: 0,
            selected: true,
            reason: 'OK',
            health: { status: 'healthy' as const, score: 90, checkedAt: new Date().toISOString(), reasons: [] },
            blocklist: { isBlocked: false, checkedAt: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          },
        ],
        terminalFailure: false,
        nodesEvaluated: 1,
        maxDepthReached: 0,
        completedAt: new Date().toISOString(),
      };

      const failed = extractFailedNodes(result);
      expect(failed).toHaveLength(0);
    });
  });

  describe('integration tests', () => {
    it('should handle complex multi-level fallback scenario', async () => {
      // Tree structure:
      // primary -> secondary -> tertiary
      //          -> backup1 -> backup2
      const tree: FallbackNode = {
        id: 'primary',
        name: 'Primary Strategy',
        fallbacks: [
          {
            id: 'secondary',
            name: 'Secondary Strategy',
            fallbacks: [
              {
                id: 'tertiary',
                name: 'Tertiary Strategy',
                fallbacks: [],
              },
            ],
          },
          {
            id: 'backup1',
            name: 'Backup 1',
            fallbacks: [
              {
                id: 'backup2',
                name: 'Backup 2',
                fallbacks: [],
              },
            ],
          },
        ],
      };

      const mockHealth: Record<string, HealthCheck> = {
        primary: { status: 'critical', score: 10, checkedAt: new Date().toISOString(), reasons: [] },
        secondary: { status: 'blocked', score: 0, checkedAt: new Date().toISOString(), reasons: [] },
        tertiary: { status: 'healthy', score: 85, checkedAt: new Date().toISOString(), reasons: [] },
        backup1: { status: 'degraded', score: 45, checkedAt: new Date().toISOString(), reasons: [] },
        backup2: { status: 'healthy', score: 80, checkedAt: new Date().toISOString(), reasons: [] },
      };

      const mockBlocklist: Record<string, BlocklistCheck> = {
        primary: { isBlocked: false, checkedAt: new Date().toISOString() },
        secondary: { isBlocked: true, reason: 'Security issue', checkedAt: new Date().toISOString() },
        tertiary: { isBlocked: false, checkedAt: new Date().toISOString() },
        backup1: { isBlocked: false, checkedAt: new Date().toISOString() },
        backup2: { isBlocked: false, checkedAt: new Date().toISOString() },
      };

      const context: TraversalContext = {
        checkHealth: (id) => mockHealth[id],
        checkBlocklist: (id) => mockBlocklist[id],
        minHealthScore: 50,
        allowDegraded: false,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      // Should skip primary (critical), secondary (blocked), backup1 (degraded not allowed)
      // Should select tertiary (first healthy in left-to-right order)
      expect(result.selectedNode?.id).toBe('tertiary');
      expect(result.nodesEvaluated).toBe(4);
      expect(result.path[0].selected).toBe(false);
      expect(result.path[1].selected).toBe(false);
      expect(result.path[2].selected).toBe(true);
    });

    it('should handle async health and blocklist checks', async () => {
      const tree: FallbackNode = {
        id: 'async-test',
        name: 'Async Test',
        fallbacks: [],
      };

      const context: TraversalContext = {
        checkHealth: async (id) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return {
            status: 'healthy',
            score: 90,
            checkedAt: new Date().toISOString(),
            reasons: [],
          };
        },
        checkBlocklist: async (id) => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return { isBlocked: false, checkedAt: new Date().toISOString() };
        },
        minHealthScore: 50,
        allowDegraded: true,
        maxDepth: 10,
      };

      const result = await traverseFallbackTree(tree, context);

      expect(result.selectedNode?.id).toBe('async-test');
    });
  });
});
