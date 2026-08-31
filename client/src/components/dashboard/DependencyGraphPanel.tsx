/**
 * DependencyGraphPanel.tsx
 *
 * Compact Service Dependency Graph Dashboard (#1100)
 *
 * Models and renders core service dependencies, identifying root-cause outages,
 * degraded downstream impacts, and real-time connectivity states across:
 * - PostgreSQL Database
 * - Redis Cache / Queues
 * - Stellar Horizon RPC
 * - Soroban RPC
 * - Event Indexer
 * - Keepers / Worker Queues
 * - API Gateway
 */

import React, { useState, useEffect, useCallback, useId } from "react";
import {
  Activity,
  Database,
  Globe,
  Layers,
  HardDrive,
  Cpu,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Radio,
  Zap,
} from "lucide-react";
import { apiUrl } from "../../lib/api";

export type ServiceId =
  | "database"
  | "cache"
  | "horizon"
  | "sorobanRpc"
  | "indexer"
  | "queues"
  | "api";

export type ServiceStatus = "up" | "down" | "warning";

export interface ServiceNode {
  id: ServiceId;
  name: string;
  category: "datastore" | "cache" | "network" | "indexer" | "workers" | "gateway";
  description: string;
  status: ServiceStatus;
  isDegraded: boolean;
  latencyMs?: number;
  errorCode?: string | null;
  retryable?: boolean;
  hint?: string;
  dependencies: ServiceId[];
  dependents: ServiceId[];
  critical: boolean;
  impactedBy: ServiceId[];
  metadata?: Record<string, unknown>;
}

export interface ServiceEdge {
  from: ServiceId;
  to: ServiceId;
  critical: boolean;
  status: "healthy" | "degraded" | "broken";
  description: string;
}

export interface GraphSummary {
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  overallStatus: "healthy" | "degraded" | "outage";
  rootCauses: ServiceId[];
  affectedServices: ServiceId[];
  blastRadius: Record<ServiceId, ServiceId[]>;
}

export interface ServiceDependencyGraphData {
  nodes: ServiceNode[];
  edges: ServiceEdge[];
  summary: GraphSummary;
  generatedAt: string;
}

export interface DependencyGraphPanelProps {
  /** Optional initial data or overrides */
  initialGraph?: ServiceDependencyGraphData;
  /** Whether to render in dense compact mode */
  compact?: boolean;
  /** Custom title */
  title?: string;
}

const DEFAULT_NODES: ServiceNode[] = [
  {
    id: "database",
    name: "PostgreSQL Database",
    category: "datastore",
    description: "Primary relational datastore for state, vaults, and event persistence",
    status: "up",
    isDegraded: false,
    latencyMs: 8,
    dependencies: [],
    dependents: ["indexer", "queues", "api"],
    critical: true,
    impactedBy: [],
  },
  {
    id: "cache",
    name: "Redis Cache & Broker",
    category: "cache",
    description: "In-memory datastore for BullMQ queues and fast key-value cache",
    status: "up",
    isDegraded: false,
    latencyMs: 2,
    dependencies: [],
    dependents: ["queues", "api"],
    critical: true,
    impactedBy: [],
  },
  {
    id: "horizon",
    name: "Stellar Horizon RPC",
    category: "network",
    description: "Stellar network Horizon endpoint for ledger querying and ingestion",
    status: "up",
    isDegraded: false,
    latencyMs: 65,
    dependencies: [],
    dependents: ["indexer", "api"],
    critical: true,
    impactedBy: [],
  },
  {
    id: "sorobanRpc",
    name: "Soroban RPC Endpoint",
    category: "network",
    description: "Soroban RPC node for smart contract invocation and simulation",
    status: "up",
    isDegraded: false,
    latencyMs: 72,
    dependencies: [],
    dependents: ["indexer", "queues", "api"],
    critical: true,
    impactedBy: [],
  },
  {
    id: "indexer",
    name: "Event & Ledger Indexer",
    category: "indexer",
    description: "Ingests on-chain contract events and ledger state into the database",
    status: "up",
    isDegraded: false,
    dependencies: ["database", "horizon", "sorobanRpc"],
    dependents: ["api"],
    critical: false,
    impactedBy: [],
  },
  {
    id: "queues",
    name: "Keepers & Workers",
    category: "workers",
    description: "BullMQ worker queues for rebalance, liquidation, and yield harvesting",
    status: "up",
    isDegraded: false,
    dependencies: ["cache", "database", "sorobanRpc"],
    dependents: ["api"],
    critical: false,
    impactedBy: [],
  },
  {
    id: "api",
    name: "Core API Gateway",
    category: "gateway",
    description: "StellarYield REST, GraphQL, and WebSocket API services",
    status: "up",
    isDegraded: false,
    dependencies: ["database", "cache", "horizon", "sorobanRpc", "indexer"],
    dependents: [],
    critical: true,
    impactedBy: [],
  },
];

const DEFAULT_GRAPH: ServiceDependencyGraphData = {
  nodes: DEFAULT_NODES,
  edges: [
    { from: "indexer", to: "database", critical: true, status: "healthy", description: "Persists events" },
    { from: "indexer", to: "horizon", critical: true, status: "healthy", description: "Streams ledgers" },
    { from: "queues", to: "cache", critical: true, status: "healthy", description: "Queue management" },
    { from: "queues", to: "database", critical: true, status: "healthy", description: "Position sync" },
    { from: "api", to: "database", critical: true, status: "healthy", description: "State storage" },
    { from: "api", to: "horizon", critical: true, status: "healthy", description: "Ledger queries" },
    { from: "api", to: "sorobanRpc", critical: true, status: "healthy", description: "Contract calls" },
  ],
  summary: {
    totalServices: 7,
    healthyServices: 7,
    degradedServices: 0,
    downServices: 0,
    overallStatus: "healthy",
    rootCauses: [],
    affectedServices: [],
    blastRadius: {
      database: [],
      cache: [],
      horizon: [],
      sorobanRpc: [],
      indexer: [],
      queues: [],
      api: [],
    },
  },
  generatedAt: new Date().toISOString(),
};

function getServiceIcon(id: ServiceId) {
  switch (id) {
    case "database":
      return <Database size={16} className="text-cyan-400" />;
    case "cache":
      return <Layers size={16} className="text-violet-400" />;
    case "horizon":
      return <Globe size={16} className="text-blue-400" />;
    case "sorobanRpc":
      return <Radio size={16} className="text-purple-400" />;
    case "indexer":
      return <HardDrive size={16} className="text-emerald-400" />;
    case "queues":
      return <Cpu size={16} className="text-amber-400" />;
    case "api":
      return <Zap size={16} className="text-indigo-400" />;
    default:
      return <Activity size={16} className="text-gray-400" />;
  }
}

export default function DependencyGraphPanel({
  initialGraph,
  compact = false,
  title = "Core Service Dependencies & Health Graph",
}: DependencyGraphPanelProps) {
  const [graph, setGraph] = useState<ServiceDependencyGraphData>(initialGraph || DEFAULT_GRAPH);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>(new Date().toISOString());
  const [expandedNode, setExpandedNode] = useState<ServiceId | null>(null);
  const [activeFilter, setActiveFilter] = useState<"all" | "degraded" | "infrastructure" | "processing">("all");
  const baseId = useId();

  const fetchDependencyGraph = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(apiUrl("/health/dependencies"));
      if (response.ok) {
        const data = await response.json();
        if (data.graph) {
          setGraph(data.graph);
          setLastRefreshed(new Date().toISOString());
        }
      }
    } catch {
      // Retain previous or fallback graph on network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialGraph) {
      fetchDependencyGraph();
    }
  }, [fetchDependencyGraph, initialGraph]);

  const summary = graph.summary;
  const isHealthy = summary.overallStatus === "healthy";
  const isDegraded = summary.overallStatus === "degraded";
  const isOutage = summary.overallStatus === "outage";

  const filteredNodes = graph.nodes.filter((node) => {
    if (activeFilter === "degraded") return node.isDegraded || node.status !== "up";
    if (activeFilter === "infrastructure") return ["datastore", "cache", "network"].includes(node.category);
    if (activeFilter === "processing") return ["indexer", "workers", "gateway"].includes(node.category);
    return true;
  });

  return (
    <div
      className={`glass-card rounded-2xl border ${
        isOutage
          ? "border-rose-500/40 shadow-rose-950/20"
          : isDegraded
            ? "border-amber-500/40 shadow-amber-950/20"
            : "border-white/10"
      } bg-gray-900/60 p-5 backdrop-blur-xl shadow-xl transition-all duration-300`}
      data-testid="dependency-graph-panel"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div
            className={`p-2.5 rounded-xl ${
              isOutage
                ? "bg-rose-500/20 text-rose-400"
                : isDegraded
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-emerald-500/20 text-emerald-400"
            }`}
          >
            <Activity size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white tracking-wide">{title}</h3>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider ${
                  isOutage
                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                    : isDegraded
                      ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                      : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    isOutage ? "bg-rose-400 animate-ping" : isDegraded ? "bg-amber-400" : "bg-emerald-400"
                  }`}
                />
                {summary.overallStatus}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Directional graph & blast-radius monitoring • Last check: {new Date(lastRefreshed).toLocaleTimeString()}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <div className="flex bg-black/40 rounded-lg p-0.5 border border-white/10 text-xs">
            <button
              onClick={() => setActiveFilter("all")}
              className={`px-2.5 py-1 rounded-md transition ${
                activeFilter === "all" ? "bg-white/15 text-white font-medium" : "text-gray-400 hover:text-white"
              }`}
            >
              All ({graph.nodes.length})
            </button>
            <button
              onClick={() => setActiveFilter("degraded")}
              className={`px-2.5 py-1 rounded-md transition flex items-center gap-1 ${
                activeFilter === "degraded" ? "bg-amber-500/30 text-amber-200 font-medium" : "text-gray-400 hover:text-amber-300"
              }`}
            >
              Degraded ({summary.degradedServices + summary.downServices})
            </button>
            <button
              onClick={() => setActiveFilter("infrastructure")}
              className={`px-2.5 py-1 rounded-md transition ${
                activeFilter === "infrastructure" ? "bg-white/15 text-white font-medium" : "text-gray-400 hover:text-white"
              }`}
            >
              Infra
            </button>
          </div>

          <button
            onClick={fetchDependencyGraph}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-gray-300 transition disabled:opacity-50"
            title="Refresh dependencies"
            aria-label="Refresh dependency graph"
          >
            <RefreshCw size={13} className={loading ? "animate-spin text-purple-400" : "text-gray-400"} />
            <span>Sync</span>
          </button>
        </div>
      </div>

      {/* Root Cause Alert Banner when degraded */}
      {(summary.rootCauses.length > 0 || isOutage || isDegraded) && (
        <div
          className={`mt-4 rounded-xl border p-4 ${
            isOutage
              ? "bg-rose-950/40 border-rose-500/40 text-rose-200"
              : "bg-amber-950/40 border-amber-500/40 text-amber-200"
          }`}
          data-testid="root-cause-banner"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className={`h-5 w-5 flex-shrink-0 mt-0.5 ${isOutage ? "text-rose-400" : "text-amber-400"}`} />
            <div className="space-y-1.5 text-xs">
              <div className="font-semibold text-sm flex items-center gap-2">
                <span>
                  {isOutage ? "Critical Service Outage Detected" : "Service Dependency Degradation Detected"}
                </span>
                <span className="px-2 py-0.5 rounded bg-black/40 text-xs font-mono font-normal">
                  Root Cause: {summary.rootCauses.join(", ") || "Upstream Network"}
                </span>
              </div>
              <p className="opacity-90">
                {summary.rootCauses.length > 0
                  ? `Root-cause node "${summary.rootCauses.join(", ")}" is degraded. Impacted downstream services: ${
                      summary.affectedServices.length > 0 ? summary.affectedServices.join(", ") : "None"
                    }.`
                  : "One or more dependencies are operating with elevated latency or lag."}
              </p>
              {graph.nodes.find((n) => summary.rootCauses.includes(n.id))?.hint && (
                <div className="mt-1 pt-1 border-t border-white/10 font-mono text-[11px] text-amber-300/90">
                  Remediation: {graph.nodes.find((n) => summary.rootCauses.includes(n.id))?.hint}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Summary KPI Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <div className="rounded-xl bg-black/30 border border-white/5 p-3 text-center">
          <div className="text-xs text-gray-400 uppercase font-semibold tracking-wider">Total Services</div>
          <div className="text-xl font-extrabold text-white mt-1">{summary.totalServices}</div>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/5 p-3 text-center">
          <div className="text-xs text-emerald-400/90 uppercase font-semibold tracking-wider">Healthy</div>
          <div className="text-xl font-extrabold text-emerald-400 mt-1">{summary.healthyServices}</div>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/5 p-3 text-center">
          <div className="text-xs text-amber-400/90 uppercase font-semibold tracking-wider">Degraded</div>
          <div className="text-xl font-extrabold text-amber-400 mt-1">{summary.degradedServices}</div>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/5 p-3 text-center">
          <div className="text-xs text-rose-400/90 uppercase font-semibold tracking-wider">Down</div>
          <div className="text-xl font-extrabold text-rose-400 mt-1">{summary.downServices}</div>
        </div>
      </div>

      {/* Compact Dependency Grid */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredNodes.map((node) => {
          const isNodeExpanded = expandedNode === node.id;
          const isNodeDown = node.status === "down";
          const isNodeWarning = node.status === "warning";
          const isImpacted = node.impactedBy.length > 0;
          const isPrimaryRoot = summary.rootCauses.includes(node.id);

          return (
            <div
              key={node.id}
              className={`rounded-xl border p-3.5 transition-all duration-200 ${
                isNodeDown
                  ? "bg-rose-950/20 border-rose-500/40 hover:border-rose-500/60"
                  : isNodeWarning
                    ? "bg-amber-950/20 border-amber-500/40 hover:border-amber-500/60"
                    : "bg-black/30 border-white/10 hover:border-white/20"
              }`}
              data-testid={`service-node-${node.id}`}
            >
              {/* Card Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-white/5 border border-white/10">
                    {getServiceIcon(node.id)}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-white">{node.name}</span>
                      {node.critical && (
                        <span className="text-[10px] uppercase font-bold px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                          Core
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-gray-400 capitalize">{node.category}</span>
                  </div>
                </div>

                {/* Status Badge */}
                <div className="flex flex-col items-end gap-1">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                      isNodeDown
                        ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                        : isNodeWarning
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                          : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                    }`}
                  >
                    {isNodeDown ? (
                      <XCircle size={12} />
                    ) : isNodeWarning ? (
                      <AlertTriangle size={12} />
                    ) : (
                      <CheckCircle2 size={12} />
                    )}
                    <span className="uppercase">{node.status}</span>
                  </span>

                  {node.latencyMs !== undefined && (
                    <span className="text-[10px] font-mono text-gray-400">{node.latencyMs}ms</span>
                  )}
                </div>
              </div>

              {/* Degradation / Root Cause Callout */}
              {isPrimaryRoot && (
                <div className="mt-2 text-[11px] bg-rose-500/15 border border-rose-500/30 text-rose-300 rounded-md px-2 py-1 font-semibold flex items-center gap-1.5">
                  <AlertTriangle size={12} />
                  <span>Primary Root Cause of Degradation</span>
                </div>
              )}

              {isImpacted && !isPrimaryRoot && (
                <div className="mt-2 text-[11px] bg-amber-500/15 border border-amber-500/30 text-amber-300 rounded-md px-2 py-1 flex items-center gap-1.5">
                  <AlertTriangle size={12} />
                  <span>
                    Impacted by upstream: <strong className="font-semibold">{node.impactedBy.join(", ")}</strong>
                  </span>
                </div>
              )}

              {/* Dependencies & Dependents Mini Chips */}
              <div className="mt-3 pt-2.5 border-t border-white/5 space-y-1.5 text-[11px]">
                {node.dependencies.length > 0 && (
                  <div className="flex items-center gap-1.5 text-gray-400">
                    <span className="text-[10px] uppercase font-semibold text-gray-500">Requires:</span>
                    <div className="flex flex-wrap gap-1">
                      {node.dependencies.map((dep) => (
                        <span
                          key={dep}
                          className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-300 font-mono text-[10px]"
                        >
                          {dep}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {node.dependents.length > 0 && (
                  <div className="flex items-center gap-1.5 text-gray-400">
                    <span className="text-[10px] uppercase font-semibold text-gray-500">Supports:</span>
                    <div className="flex flex-wrap gap-1">
                      {node.dependents.map((dep) => (
                        <span
                          key={dep}
                          className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-300 font-mono text-[10px]"
                        >
                          {dep}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Toggle Details Button */}
              {(node.hint || node.errorCode || node.description) && (
                <button
                  onClick={() => setExpandedNode(isNodeExpanded ? null : node.id)}
                  className="mt-2 w-full text-left text-[11px] text-gray-400 hover:text-white flex items-center justify-between pt-1 border-t border-white/5 transition"
                  aria-expanded={isNodeExpanded}
                >
                  <span>{isNodeExpanded ? "Hide diagnostics" : "View diagnostics"}</span>
                  {isNodeExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              )}

              {/* Expanded Diagnostic Detail */}
              {isNodeExpanded && (
                <div className="mt-2 pt-2 border-t border-white/10 space-y-1 text-xs text-gray-300 font-mono bg-black/40 rounded-lg p-2.5">
                  <p className="text-gray-400 font-sans text-[11px]">{node.description}</p>
                  {node.errorCode && (
                    <div>
                      <span className="text-gray-500">Error Code: </span>
                      <span className="text-rose-400 font-bold">{node.errorCode}</span>
                    </div>
                  )}
                  {node.hint && (
                    <div>
                      <span className="text-gray-500">Hint: </span>
                      <span className="text-amber-300">{node.hint}</span>
                    </div>
                  )}
                  {node.metadata && Object.keys(node.metadata).length > 0 && (
                    <div className="text-[11px] text-gray-400 pt-1">
                      {Object.entries(node.metadata).map(([k, v]) => (
                        <div key={k}>
                          {k}: <span className="text-white">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
