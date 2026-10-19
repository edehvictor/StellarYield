import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import DependencyGraphPanel, {
  type ServiceDependencyGraphData,
} from "../DependencyGraphPanel";

const mockHealthyGraph: ServiceDependencyGraphData = {
  nodes: [
    {
      id: "database",
      name: "PostgreSQL Database",
      category: "datastore",
      description: "Primary database",
      status: "up",
      isDegraded: false,
      latencyMs: 12,
      dependencies: [],
      dependents: ["indexer", "queues", "api"],
      critical: true,
      impactedBy: [],
    },
    {
      id: "horizon",
      name: "Stellar Horizon RPC",
      category: "network",
      description: "Horizon endpoint",
      status: "up",
      isDegraded: false,
      latencyMs: 45,
      dependencies: [],
      dependents: ["indexer", "api"],
      critical: true,
      impactedBy: [],
    },
    {
      id: "indexer",
      name: "Event & Ledger Indexer",
      category: "indexer",
      description: "Event indexer",
      status: "up",
      isDegraded: false,
      latencyMs: 15,
      dependencies: ["database", "horizon"],
      dependents: ["api"],
      critical: false,
      impactedBy: [],
    },
  ],
  edges: [
    { from: "indexer", to: "database", critical: true, status: "healthy", description: "Storage" },
    { from: "indexer", to: "horizon", critical: true, status: "healthy", description: "Stream" },
  ],
  summary: {
    totalServices: 3,
    healthyServices: 3,
    degradedServices: 0,
    downServices: 0,
    overallStatus: "healthy",
    rootCauses: [],
    affectedServices: [],
    blastRadius: {
      database: [],
      horizon: [],
      indexer: [],
      cache: [],
      sorobanRpc: [],
      queues: [],
      api: [],
    },
  },
  generatedAt: new Date().toISOString(),
};

const mockOutageGraph: ServiceDependencyGraphData = {
  nodes: [
    {
      id: "database",
      name: "PostgreSQL Database",
      category: "datastore",
      description: "Primary database",
      status: "down",
      isDegraded: true,
      errorCode: "DB_UNREACHABLE",
      hint: "Check Postgres connection pool",
      dependencies: [],
      dependents: ["indexer", "queues", "api"],
      critical: true,
      impactedBy: [],
    },
    {
      id: "horizon",
      name: "Stellar Horizon RPC",
      category: "network",
      description: "Horizon endpoint",
      status: "up",
      isDegraded: false,
      dependencies: [],
      dependents: ["indexer", "api"],
      critical: true,
      impactedBy: [],
    },
    {
      id: "indexer",
      name: "Event & Ledger Indexer",
      category: "indexer",
      description: "Event indexer",
      status: "warning",
      isDegraded: true,
      dependencies: ["database", "horizon"],
      dependents: ["api"],
      critical: false,
      impactedBy: ["database"],
    },
  ],
  edges: [
    { from: "indexer", to: "database", critical: true, status: "broken", description: "Storage" },
    { from: "indexer", to: "horizon", critical: true, status: "healthy", description: "Stream" },
  ],
  summary: {
    totalServices: 3,
    healthyServices: 1,
    degradedServices: 1,
    downServices: 1,
    overallStatus: "outage",
    rootCauses: ["database"],
    affectedServices: ["indexer"],
    blastRadius: {
      database: ["indexer"],
      horizon: [],
      indexer: [],
      cache: [],
      sorobanRpc: [],
      queues: [],
      api: [],
    },
  },
  generatedAt: new Date().toISOString(),
};

describe("DependencyGraphPanel Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders healthy dependency graph summary and service nodes", () => {
    render(<DependencyGraphPanel initialGraph={mockHealthyGraph} />);

    expect(screen.getByText(/Core Service Dependencies/i)).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL Database")).toBeInTheDocument();
    expect(screen.getByText("Stellar Horizon RPC")).toBeInTheDocument();
    expect(screen.getByText("Event & Ledger Indexer")).toBeInTheDocument();
    expect(screen.queryByTestId("root-cause-banner")).not.toBeInTheDocument();
  });

  it("renders root cause banner and highlights degraded services during outage", () => {
    render(<DependencyGraphPanel initialGraph={mockOutageGraph} />);

    const rootCauseBanner = screen.getByTestId("root-cause-banner");
    expect(rootCauseBanner).toBeInTheDocument();
    expect(screen.getByText(/Root Cause: database/i)).toBeInTheDocument();
    expect(screen.getByText(/Primary Root Cause of Degradation/i)).toBeInTheDocument();
    expect(screen.getByText(/Impacted by upstream:/i)).toBeInTheDocument();
  });

  it("filters services when Degraded or Infra filter tab is clicked", () => {
    render(<DependencyGraphPanel initialGraph={mockOutageGraph} />);

    // Click Degraded filter
    const degradedBtn = screen.getByRole("button", { name: /Degraded/i });
    fireEvent.click(degradedBtn);

    // Database (down) and Indexer (impacted/warning) should show, Horizon (up) should not
    expect(screen.getByText("PostgreSQL Database")).toBeInTheDocument();
    expect(screen.getByText("Event & Ledger Indexer")).toBeInTheDocument();
    expect(screen.queryByText("Stellar Horizon RPC")).not.toBeInTheDocument();

    // Click All filter
    const allBtn = screen.getByRole("button", { name: /All/i });
    fireEvent.click(allBtn);
    expect(screen.getByText("Stellar Horizon RPC")).toBeInTheDocument();
  });

  it("expands diagnostic details including error codes and hints", () => {
    render(<DependencyGraphPanel initialGraph={mockOutageGraph} />);

    const diagBtn = screen.getAllByText("View diagnostics")[0];
    fireEvent.click(diagBtn);

    expect(screen.getByText("DB_UNREACHABLE")).toBeInTheDocument();
    expect(screen.getByText("Check Postgres connection pool")).toBeInTheDocument();
  });

  it("fetches dependency updates when Sync button is clicked", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ graph: mockHealthyGraph }),
    } as any);

    render(<DependencyGraphPanel initialGraph={mockHealthyGraph} />);

    const syncBtn = screen.getByRole("button", { name: /Refresh dependency graph/i });
    fireEvent.click(syncBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
