# Hierarchical Strategy Fallback Tree - Documentation

## Overview

The Hierarchical Strategy Fallback Tree service provides a structured approach to selecting the next-best safe alternative strategy or protocol when the primary choice fails or is excluded. This system ensures that strategy services can gracefully degrade while maintaining safety and auditability.

## Design Principles

1. **Safety-First**: Traversal never routes into blocked or unhealthy branches
2. **Deterministic**: Given the same tree and health state, traversal always produces the same result
3. **Audit Trail**: Every traversal decision is logged with detailed reasons
4. **Cycle Detection**: Prevents infinite loops in malformed trees
5. **Terminal Failure**: Gracefully handles cases where no viable path exists

## Tree Semantics

### Structure

A fallback tree is a hierarchical structure where:
- Each node represents a strategy or protocol
- Nodes have ordered children as fallback options
- Traversal follows depth-first, left-to-right order
- The first viable node encountered is selected

### Node Viability

A node is considered viable if it passes all safety checks:
1. **Blocklist Check**: Node must not be explicitly blocked
2. **Health Score**: Node's health score must meet minimum threshold
3. **Status Check**: Node's status must be acceptable (healthy or degraded if allowed)

### Traversal Algorithm

```
1. Start at root node
2. Check if current node is viable
   - If viable: select this node and stop
   - If not viable: continue to step 3
3. For each child in order (left to right):
   - Recursively traverse child subtree
   - If child subtree returns a viable node: select it and stop
4. If no viable node found in subtree, backtrack to parent
5. If root has no viable path: return terminal failure
```

### Cycle Prevention

The service implements two levels of cycle detection:
1. **Static Validation**: Tree structure is validated at registration time
2. **Runtime Detection**: Traversal tracks visited nodes to prevent cycles during execution

## API Reference

### Core Types

#### FallbackNode
```typescript
interface FallbackNode {
  id: string;                    // Unique identifier
  name: string;                  // Human-readable name
  fallbacks: FallbackNode[];     // Ordered fallback options
  priority?: number;            // Optional priority for tie-breaking
  metadata?: Record<string, unknown>; // Custom metadata
}
```

#### HealthCheck
```typescript
interface HealthCheck {
  status: NodeStatus;           // Current health status
  score: number;                // Health score (0-100)
  checkedAt: string;           // ISO-8601 timestamp
  reasons: string[];            // Reasons for current status
}
```

#### BlocklistCheck
```typescript
interface BlocklistCheck {
  isBlocked: boolean;           // Whether node is blocked
  reason?: string;              // Reason for block (if blocked)
  checkedAt: string;            // ISO-8601 timestamp
}
```

#### TraversalContext
```typescript
interface TraversalContext {
  checkHealth: (nodeId: string) => Promise<HealthCheck> | HealthCheck;
  checkBlocklist: (nodeId: string) => Promise<BlocklistCheck> | BlocklistCheck;
  minHealthScore: number;        // Minimum health score (0-100)
  allowDegraded: boolean;        // Allow degraded nodes
  maxDepth: number;              // Maximum traversal depth
  now?: number;                  // Current timestamp
}
```

#### TraversalResult
```typescript
interface TraversalResult {
  selectedNode: FallbackNode | null;  // Selected node (if any)
  path: TraversalStep[];               // Full traversal path
  terminalFailure: boolean;           // Whether traversal failed
  terminalFailureReason?: string;     // Reason for failure
  nodesEvaluated: number;              // Total nodes evaluated
  maxDepthReached: number;            // Maximum depth reached
  completedAt: string;                // Completion timestamp
}
```

### Core Functions

#### validateFallbackTree
Validates a fallback tree structure before use.

```typescript
function validateFallbackTree(root: FallbackNode): {
  valid: boolean;
  errors: string[];
}
```

**Checks performed:**
- Detects cycles in the tree structure
- Detects duplicate node IDs at the same level
- Returns validation result with detailed error messages

#### traverseFallbackTree
Traverses a fallback tree to find the first viable node.

```typescript
async function traverseFallbackTree(
  root: FallbackNode,
  context: TraversalContext
): Promise<TraversalResult>
```

**Behavior:**
- Performs depth-first, left-to-right traversal
- Applies safety checks at each node
- Tracks full traversal path with reasons
- Returns terminal failure if no viable path exists

#### createFallbackTreeFromList
Creates a fallback tree from a flat list of strategies.

```typescript
function createFallbackTreeFromList(
  strategies: Array<{ id: string; name: string; priority?: number }>
): FallbackNode
```

**Sorting behavior:**
- Strategies sorted by priority (descending)
- Ties broken by ID (alphabetical)
- Creates a chain structure: first -> second -> third

### Registry Class

#### FallbackTreeRegistry
Stateful registry for managing fallback trees and traversal history.

**Methods:**
- `registerTree(key, root)`: Register a fallback tree
- `getTree(key)`: Retrieve a registered tree
- `removeTree(key)`: Remove a registered tree
- `getTreeKeys()`: List all registered tree keys
- `traverse(key, contextOverrides)`: Traverse a registered tree
- `getTraversalHistory(limit)`: Get recent traversal history
- `getTraversalHistoryForTree(key, limit)`: Get history for specific tree
- `clearHistory()`: Clear traversal history
- `updateConfig(newConfig)`: Update configuration
- `getConfig()`: Get current configuration
- `reset()`: Reset registry state (test hook)

## Usage Examples

### Basic Usage

```typescript
import {
  fallbackTreeRegistry,
  createFallbackTreeFromList,
} from './services';

// Create a fallback tree from a list
const strategies = [
  { id: 'primary', name: 'Primary Strategy', priority: 10 },
  { id: 'secondary', name: 'Secondary Strategy', priority: 5 },
  { id: 'tertiary', name: 'Tertiary Strategy', priority: 1 },
];

const tree = createFallbackTreeFromList(strategies);

// Register the tree
fallbackTreeRegistry.registerTree('yield-strategies', tree);

// Traverse with health and blocklist checks
const result = await fallbackTreeRegistry.traverse('yield-strategies', {
  checkHealth: async (nodeId) => {
    // Implement health check logic
    const health = await checkStrategyHealth(nodeId);
    return {
      status: health.status,
      score: health.score,
      checkedAt: new Date().toISOString(),
      reasons: health.reasons,
    };
  },
  checkBlocklist: async (nodeId) => {
    // Implement blocklist check logic
    const blocked = await isStrategyBlocked(nodeId);
    return {
      isBlocked: blocked,
      reason: blocked ? 'Manual block' : undefined,
      checkedAt: new Date().toISOString(),
    };
  },
  minHealthScore: 70,
  allowDegraded: false,
  maxDepth: 10,
});

if (result.terminalFailure) {
  console.error('No viable strategy found:', result.terminalFailureReason);
} else {
  console.log('Selected strategy:', result.selectedNode?.name);
}
```

### Custom Tree Structure

```typescript
import { fallbackTreeRegistry, validateFallbackTree } from './services';

// Create a custom tree structure
const customTree: FallbackNode = {
  id: 'blend',
  name: 'Blend Protocol',
  fallbacks: [
    {
      id: 'soroban',
      name: 'Soroban Protocol',
      fallbacks: [
        {
          id: 'phoenix',
          name: 'Phoenix Protocol',
          fallbacks: [],
        },
      ],
    },
    {
      id: 'aquarius',
      name: 'Aquarius Protocol',
      fallbacks: [],
    },
  ],
};

// Validate before registration
const validation = validateFallbackTree(customTree);
if (!validation.valid) {
  throw new Error(`Invalid tree: ${validation.errors.join(', ')}`);
}

// Register and traverse
fallbackTreeRegistry.registerTree('custom-protocols', customTree);
const result = await fallbackTreeRegistry.traverse('custom-protocols', {
  // ... context
});
```

### Analyzing Traversal Results

```typescript
import { formatTraversalResult, extractFailedNodes } from './services';

const result = await fallbackTreeRegistry.traverse('my-tree', context);

// Format result for logging
console.log(formatTraversalResult(result));

// Extract failed nodes for analysis
const failedNodes = extractFailedNodes(result);
failedNodes.forEach(node => {
  console.log(`${node.nodeName} failed: ${node.reason} (score: ${node.healthScore})`);
});

// Access full traversal path
result.path.forEach(step => {
  console.log(`Depth ${step.depth}: ${step.nodeName} - ${step.selected ? 'SELECTED' : 'SKIPPED'} (${step.reason})`);
});
```

## Integration with Existing Services

### Strategy Health Service Integration

```typescript
import { strategyHealthEngine } from './services/strategyHealthService';
import { fallbackTreeRegistry } from './services/fallbackTreeService';

const result = await fallbackTreeRegistry.traverse('my-tree', {
  checkHealth: async (nodeId) => {
    const healthScore = await strategyHealthEngine.calculateHealthScore(nodeId, nodeId);
    return {
      status: healthScore.status,
      score: healthScore.overallScore,
      checkedAt: healthScore.lastUpdated,
      reasons: healthScore.recommendations,
    };
  },
  checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
  minHealthScore: 60,
  allowDegraded: true,
  maxDepth: 10,
});
```

### Protocol Failover Service Integration

```typescript
import { failoverRegistry } from './services/protocolFailoverService';
import { fallbackTreeRegistry } from './services/fallbackTreeService';

const result = await fallbackTreeRegistry.traverse('my-tree', {
  checkHealth: async (nodeId) => {
    // Use failover service health data
    const health = failoverRegistry.excludedProtocols().includes(nodeId)
      ? { status: 'down' as const, score: 0, checkedAt: new Date().toISOString(), reasons: ['Excluded by failover'] }
      : { status: 'healthy' as const, score: 100, checkedAt: new Date().toISOString(), reasons: [] };
    return health;
  },
  checkBlocklist: async (nodeId) => {
    const isBlocked = failoverRegistry.excludedProtocols().includes(nodeId);
    return {
      isBlocked,
      reason: isBlocked ? 'Excluded by failover service' : undefined,
      checkedAt: new Date().toISOString(),
    };
  },
  minHealthScore: 50,
  allowDegraded: true,
  maxDepth: 10,
});
```

## Configuration

### Default Configuration

```typescript
const DEFAULT_FALLBACK_CONFIG = {
  defaultMinHealthScore: 50,      // Minimum health score (0-100)
  defaultAllowDegraded: true,     // Allow degraded nodes
  defaultMaxDepth: 20,            // Maximum traversal depth
  maxHistorySize: 1000,           // Maximum traversal history entries
};
```

### Custom Configuration

```typescript
import { FallbackTreeRegistry } from './services/fallbackTreeService';

const registry = new FallbackTreeRegistry({
  defaultMinHealthScore: 70,
  defaultAllowDegraded: false,
  defaultMaxDepth: 15,
  maxHistorySize: 500,
});

// Update configuration at runtime
registry.updateConfig({
  defaultMinHealthScore: 80,
});
```

## Security Considerations

### Blocklist Enforcement

The fallback tree service enforces blocklist checks at every node:
- Blocked nodes are never selected, regardless of health score
- Blocklist reasons are recorded in the traversal path
- Blocklist checks are performed before health checks for efficiency

### Health Thresholds

Health thresholds prevent routing to unhealthy strategies:
- Minimum health score can be configured per traversal
- Degraded nodes can be optionally allowed
- Critical and blocked statuses always result in exclusion

### Cycle Prevention

Cycle detection prevents infinite loops:
- Static validation at tree registration
- Runtime tracking during traversal
- Maximum depth limit as safety net

## Testing

### Running Tests

```bash
cd server
npm test -- fallbackTreeService.test.ts
```

### Test Coverage

The test suite covers:
- Tree validation (cycles, duplicates)
- Basic ordering (priority-based, depth-first)
- Safety checks (blocklist, health score, status)
- Cycle prevention (static and runtime)
- Terminal failure states (all unhealthy, all blocked, max depth)
- Registry state management
- Traversal history tracking
- Helper functions (format, extract failures)
- Integration scenarios

### Test Structure

Tests are organized by feature:
- `validateFallbackTree`: Tree structure validation
- `traverseFallbackTree - basic ordering`: Selection logic
- `traverseFallbackTree - safety checks`: Health and blocklist
- `traverseFallbackTree - cycle prevention`: Cycle detection
- `traverseFallbackTree - terminal failure`: Failure states
- `FallbackTreeRegistry`: Registry management
- `createFallbackTreeFromList`: Helper function
- `formatTraversalResult`: Formatting utilities
- `extractFailedNodes`: Analysis utilities
- `integration tests`: End-to-end scenarios

## Troubleshooting

### Common Issues

**Issue**: Tree validation fails with "Cycle detected"
- **Solution**: Check for circular references in your tree structure
- **Example**: Node A -> Node B -> Node A creates a cycle

**Issue**: Traversal returns terminal failure
- **Solution**: Check health scores and blocklist status for all nodes
- **Debug**: Use `extractFailedNodes()` to see why each node failed

**Issue**: Traversal takes too long
- **Solution**: Reduce `maxDepth` or simplify tree structure
- **Optimization**: Cache health check results to reduce I/O

**Issue**: Wrong node selected
- **Solution**: Verify priority ordering and tree structure
- **Debug**: Check traversal path to see evaluation order

### Debug Mode

Enable detailed logging by examining the traversal path:

```typescript
const result = await fallbackTreeRegistry.traverse('my-tree', context);

result.path.forEach(step => {
  console.log(`[${step.depth}] ${step.nodeName}:`);
  console.log(`  Selected: ${step.selected}`);
  console.log(`  Reason: ${step.reason}`);
  console.log(`  Health: ${step.health.status} (${step.health.score})`);
  console.log(`  Blocked: ${step.blocklist.isBlocked}`);
});
```

## Performance Considerations

### Traversal Complexity

- **Time Complexity**: O(n) where n is the number of nodes
- **Space Complexity**: O(d) where d is the maximum depth
- **Optimization**: Early termination on first viable node

### Caching Strategy

- Health check results should be cached at the provider level
- Blocklist status changes infrequently, can be cached longer
- Traversal history is bounded by configuration

### Memory Management

- Traversal history is bounded (default: 1000 entries)
- Old entries are automatically evicted
- Registry can be reset to free memory

## Best Practices

1. **Validate Trees**: Always validate trees before registration
2. **Set Appropriate Thresholds**: Configure health thresholds based on risk tolerance
3. **Monitor Traversal History**: Review history to detect patterns
4. **Handle Terminal Failure**: Always check for terminal failure in production
5. **Log Traversal Paths**: Use traversal paths for debugging and auditing
6. **Test Edge Cases**: Test with all nodes unhealthy, blocked, or degraded
7. **Keep Trees Shallow**: Deeper trees increase traversal time and complexity
8. **Use Priority Wisely**: Higher priority nodes should be more reliable
9. **Integrate with Health Services**: Use existing health check infrastructure
10. **Document Tree Structure**: Maintain documentation for complex trees

## Migration Guide

### From Simple Fallback Lists

If you're currently using simple arrays for fallbacks:

```typescript
// Old approach
const fallbacks = ['strategy-a', 'strategy-b', 'strategy-c'];
const selected = fallbacks.find(id => isHealthy(id));

// New approach
const tree = createFallbackTreeFromList(
  fallbacks.map(id => ({ id, name: id }))
);
const result = await traverseFallbackTree(tree, context);
const selected = result.selectedNode?.id;
```

### From Ad-Hoc Fallback Logic

Replace ad-hoc fallback logic with structured trees:

```typescript
// Old approach
let selected = primaryStrategy;
if (!isHealthy(selected)) {
  selected = secondaryStrategy;
  if (!isHealthy(selected)) {
    selected = tertiaryStrategy;
  }
}

// New approach
const tree = {
  id: primaryStrategy,
  name: primaryStrategy,
  fallbacks: [
    {
      id: secondaryStrategy,
      name: secondaryStrategy,
      fallbacks: [
        {
          id: tertiaryStrategy,
          name: tertiaryStrategy,
          fallbacks: [],
        },
      ],
    },
  ],
};
const result = await traverseFallbackTree(tree, context);
const selected = result.selectedNode?.id;
```

## Future Enhancements

Potential future improvements:
- Weighted fallback selection (not just ordered)
- Parallel health checking for performance
- Machine learning-based priority adjustment
- Automatic tree optimization based on historical success rates
- Distributed fallback tree coordination across services
- Real-time tree visualization and monitoring
