import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TransparencyDashboard from "./TransparencyDashboard";

vi.mock("./transparencyServiceHealth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transparencyServiceHealth")>();
  return {
    ...actual,
    assessRegistryFromRecords: vi.fn(() => "healthy" as const),
  };
});

vi.mock("./VaultReliabilityPanel", () => ({
  default: () => <div>VaultReliabilityPanel</div>,
}));
vi.mock("./AuditReplayReportPanel", () => ({
  default: () => <div>AuditReplayReportPanel</div>,
}));
vi.mock("./RegistryDiff", () => ({
  default: () => <div>RegistryDiffPage</div>,
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Line: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  Legend: () => <div />,
}));

const mockTransparencyData = {
  totalRevenueLumens: 372000,
  totalBurnedTokens: 96000,
  deflationaryRatio: 32,
  history: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, "0")}`,
    revenue: 12000 + i * 100,
    burned: 3200 + i * 10,
  })),
};

interface HealthMockOptions {
  incidents?: unknown[];
  indexerStatus?: string;
  relayer?: { isOnline: boolean; failureCount: number; successRate: number };
  smokeRaw?: string | null;
  indexerOk?: boolean;
  relayerOk?: boolean;
}

function makeFetchMock({
  incidents = [],
  indexerStatus = "healthy",
  relayer = { isOnline: true, failureCount: 0, successRate: 100 },
  smokeRaw = null,
  indexerOk = true,
  relayerOk = true,
}: HealthMockOptions = {}) {
  return vi.fn().mockImplementation((url: string) => {
    const path = String(url);
    if (path.includes("failover-history")) {
      return Promise.resolve({ ok: true, json: async () => ({ incidents }) });
    }
    if (path.includes("/api/indexer/status")) {
      return Promise.resolve({
        ok: indexerOk,
        json: async () => ({ status: indexerStatus }),
      });
    }
    if (path.includes("/api/relayer/status")) {
      return Promise.resolve({
        ok: relayerOk,
        json: async () => relayer,
      });
    }
    if (path.includes("/api/transparency/summary")) {
      return Promise.resolve({ ok: true, json: async () => mockTransparencyData });
    }
    if (path.includes("/api/reliability")) {
      return Promise.resolve({ ok: true, json: async () => ({ providers: [] }) });
    }
    if (path.includes("/api/audit-replay")) {
      return Promise.resolve({ ok: true, json: async () => ({ summary: {} }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

beforeEach(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

describe("TransparencyDashboard – failover incident history", () => {
  it("shows 'No failover incidents recorded' when history is empty", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    render(<TransparencyDashboard />);
    await waitFor(() =>
      expect(screen.getByText("Provider Failover Incident History")).toBeInTheDocument(),
    );
    expect(screen.getByText("No failover incidents recorded.")).toBeInTheDocument();
  });

  it("renders an active incident", async () => {
    const incidents = [
      {
        id: "1",
        protocolId: "blend",
        protocolName: "Blend",
        trigger: "stale_data",
        reasons: ["data is stale"],
        startedAt: "2026-05-01T10:00:00.000Z",
        resolved: false,
      },
    ];
    vi.stubGlobal("fetch", makeFetchMock({ incidents }));
    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("Blend")).toBeInTheDocument());
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/stale data/i)).toBeInTheDocument();
  });

  it("renders a recovered incident with duration", async () => {
    const incidents = [
      {
        id: "2",
        protocolId: "soroswap",
        protocolName: "Soroswap",
        trigger: "outage",
        reasons: ["status=down"],
        startedAt: "2026-05-01T10:00:00.000Z",
        recoveredAt: "2026-05-01T10:05:00.000Z",
        durationMs: 300000,
        resolved: true,
      },
    ];
    vi.stubGlobal("fetch", makeFetchMock({ incidents }));
    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("Soroswap")).toBeInTheDocument());
    expect(screen.getByText("Recovered")).toBeInTheDocument();
    expect(screen.getByText(/300s outage/i)).toBeInTheDocument();
  });
});

describe("TransparencyDashboard – mixed service health (#865)", () => {
  it("shows healthy summary when all subsystems are healthy", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) =>
        key === "stellar-yield.smoke-results"
          ? JSON.stringify({
              timestamp: "2026-05-01T10:00:00.000Z",
              frontendUrl: "https://example.com",
              backendUrl: "https://api.example.com",
              status: "pass",
              checks: [{ label: "Health", url: "/health", status: "pass", httpCode: 200 }],
            })
          : null,
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    render(<TransparencyDashboard />);
    await waitFor(() =>
      expect(screen.getByText(/All transparency subsystems are healthy/)).toBeInTheDocument(),
    );
    expect(screen.getAllByText("Healthy").length).toBeGreaterThanOrEqual(4);
  });

  it("prioritizes failed relayer over degraded indexer", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        indexerStatus: "degraded",
        relayer: { isOnline: false, failureCount: 3, successRate: 20 },
      }),
    );

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText(/Critical:/)).toBeInTheDocument());
    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Degraded")).toBeInTheDocument();
  });

  it("handles partial data availability when health endpoints fail", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({ indexerOk: false, relayerOk: false }),
    );

    render(<TransparencyDashboard />);
    await waitFor(() =>
      expect(screen.getByText(/Degraded:/)).toBeInTheDocument(),
    );
  });

  it("shows smoke test failure in the health summary", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) =>
        key === "stellar-yield.smoke-results"
          ? JSON.stringify({
              timestamp: "2026-05-01T10:00:00.000Z",
              frontendUrl: "https://example.com",
              backendUrl: "https://api.example.com",
              status: "fail",
              checks: [{ label: "Health", url: "/health", status: "fail", httpCode: 500 }],
            })
          : null,
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText(/Critical:/)).toBeInTheDocument());
    expect(screen.getByText(/Latest run: FAIL/)).toBeInTheDocument();
  });
});
