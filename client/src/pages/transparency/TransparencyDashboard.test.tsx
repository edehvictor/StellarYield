import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TransparencyDashboard from "./TransparencyDashboard";
import { buildTransparencyDiagnostic } from "../../../../shared/types/transparencyDiagnostic";

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
vi.mock("../../components/SorobanRpcFailoverPanel", () => ({
  default: () => <div>SorobanRpcFailoverPanel</div>,
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

  it("renders privacy-safe diagnostics with the failed stage and remediation path", async () => {
    const summaryBody = {
      ...mockTransparencyData,
      status: "degraded" as const,
      diagnostics: [
        buildTransparencyDiagnostic("AGGREGATION_FAILED", { stage: "aggregation" }),
        buildTransparencyDiagnostic("STALE_LAST_KNOWN", {
          stage: "cache",
          affectedStages: ["aggregation", "cache"],
        }),
      ],
    };
    const base = makeFetchMock();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        String(url).includes("/api/transparency/summary")
          ? Promise.resolve({ ok: true, json: async () => summaryBody })
          : base(url),
      ),
    );

    render(<TransparencyDashboard />);

    await waitFor(() =>
      expect(screen.getByText("Transparency data diagnostics")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Metric aggregation/)).toBeInTheDocument();
    expect(screen.getByText(/Cached snapshot/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Next:/).length).toBeGreaterThanOrEqual(2);
    const diagnosticsPanel = screen.getByRole("alert", { name: "Transparency data diagnostics" });
    expect(within(diagnosticsPanel).getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("keeps the last known-good snapshot visible when a retry fails", async () => {
    let summaryCalls = 0;
    const degradedBody = {
      ...mockTransparencyData,
      status: "degraded" as const,
      diagnostics: [buildTransparencyDiagnostic("AGGREGATION_FAILED", { stage: "aggregation" })],
    };
    const base = makeFetchMock();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/api/transparency/summary")) {
          summaryCalls += 1;
          return summaryCalls === 1
            ? Promise.resolve({ ok: true, json: async () => degradedBody })
            : Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
        }
        return base(url);
      }),
    );

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("Total Revenue (30d)")).toBeInTheDocument());

    // Several panels expose Retry; use the one on the summary diagnostics panel.
    const diagnosticsPanel = screen.getByRole("alert", { name: "Transparency data diagnostics" });
    fireEvent.click(within(diagnosticsPanel).getByRole("button", { name: /Retry/ }));

    await waitFor(() =>
      expect(screen.getByText(/Showing the last known-good snapshot/)).toBeInTheDocument(),
    );
    // Metrics are preserved rather than replaced by an empty error view.
    expect(screen.getByText("Total Revenue (30d)")).toBeInTheDocument();
    expect(screen.getByText("Deflationary Ratio")).toBeInTheDocument();
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

describe("TransparencyDashboard – malformed external data hardening (#1913)", () => {
  it("rejects malformed summary data at the boundary without crashing and recovers on Try Again", async () => {
    let summaryCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const path = String(url);
        if (path.includes("/api/transparency/summary")) {
          summaryCallCount += 1;
          if (summaryCallCount === 1) {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                totalRevenueLumens: "corrupted",
                totalBurnedTokens: -50,
                deflationaryRatio: 200,
                history: [{ date: null, revenue: "bad", burned: null }],
              }),
            });
          }
          return Promise.resolve({ ok: true, json: async () => mockTransparencyData });
        }
        return makeFetchMock()(url);
      }),
    );

    render(<TransparencyDashboard />);
    await waitFor(() =>
      expect(screen.getByText("Unable to load data")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Try Again/i }));

    await waitFor(() =>
      expect(screen.getByText("Protocol Transparency")).toBeInTheDocument(),
    );
    expect(screen.getByText("$372,000")).toBeInTheDocument();
    expect(screen.getByText("96,000")).toBeInTheDocument();
    expect(screen.getByText("32.00%")).toBeInTheDocument();
  });

  it("preserves existing state and balances when a subsequent refresh returns malformed external data", async () => {
    let summaryCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const path = String(url);
        if (path.includes("/api/transparency/summary")) {
          summaryCallCount += 1;
          if (summaryCallCount === 1) {
            return Promise.resolve({ ok: true, json: async () => mockTransparencyData });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              totalRevenueLumens: 999999,
              totalBurnedTokens: 999999,
              deflationaryRatio: 50,
              history: [{ date: "not-a-valid-date", revenue: 100, burned: 50 }],
            }),
          });
        }
        return makeFetchMock()(url);
      }),
    );

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("$372,000")).toBeInTheDocument());
    expect(screen.getByText("96,000")).toBeInTheDocument();
    expect(screen.getByText("32.00%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh transparency data/i }));

    await waitFor(() => expect(summaryCallCount).toBe(2));
    // Existing valid balances remain intact and are not replaced by the malformed payload
    expect(screen.getByText("$372,000")).toBeInTheDocument();
    expect(screen.getByText("96,000")).toBeInTheDocument();
    expect(screen.getByText("32.00%")).toBeInTheDocument();
    expect(screen.queryByText("$999,999")).not.toBeInTheDocument();
  });

  it("isolates malformed service health, failover incident, and smoke history payloads without crashing", async () => {
    let failoverCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const path = String(url);
        if (path.includes("failover-history")) {
          failoverCallCount += 1;
          if (failoverCallCount === 1) {
            // First attempt returns malformed incident object -> triggers retry
            return Promise.resolve({
              ok: true,
              json: async () => ({ incidents: [{ id: "bad", trigger: null, reasons: "not-array" }] }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              incidents: [
                {
                  id: "1",
                  protocolId: "blend",
                  protocolName: "Blend",
                  trigger: "stale_data",
                  reasons: ["data is stale"],
                  startedAt: "2026-05-01T10:00:00.000Z",
                  resolved: false,
                },
                { id: "corrupt", trigger: 123, reasons: null },
              ],
            }),
          });
        }
        if (path.includes("/api/indexer/status")) {
          // Malformed JSON throw on indexer status should not break relayer status
          return Promise.resolve({
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected token in JSON");
            },
          });
        }
        if (path.includes("/api/relayer/status")) {
          // Incomplete relayer object missing failureCount/successRate must not report healthy
          return Promise.resolve({
            ok: true,
            json: async () => ({ isOnline: true }),
          });
        }
        return makeFetchMock()(url);
      }),
    );

    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => {
        if (key === "stellar-yield.smoke-results") {
          return JSON.stringify({
            timestamp: "not-a-timestamp",
            frontendUrl: "https://example.com",
            backendUrl: "https://api.example.com",
            status: "pass",
            checks: [{ label: null, status: "unknown" }],
          });
        }
        if (key === "stellar-yield.smoke-history") {
          return '{"malformed":"not-an-array"}';
        }
        return null;
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("Blend")).toBeInTheDocument(), {
      timeout: 2500,
    });
    expect(screen.getByText(/Degraded:/)).toBeInTheDocument();
    expect(screen.queryByText(/All transparency subsystems are healthy/)).not.toBeInTheDocument();
  });
});

describe("TransparencyDashboard – network and ledger binding (#1916)", () => {
  const withContext = (ledger: number, network = "testnet", revenue = 372000) => ({
    ...mockTransparencyData,
    totalRevenueLumens: revenue,
    context: { network, ledger, version: "1" },
  });

  function summarySequence(responses: Array<{ status?: number; body: unknown }>) {
    const urls: string[] = [];
    let call = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes("/api/transparency/summary")) {
        urls.push(path);
        const next = responses[Math.min(call, responses.length - 1)];
        call += 1;
        const status = next.status ?? 200;
        return Promise.resolve({ ok: status < 300, status, json: async () => next.body });
      }
      return makeFetchMock()(url);
    });
    return { fetchMock, urls };
  }

  it("shows the snapshot's network and ledger and sends them on refresh", async () => {
    const { fetchMock, urls } = summarySequence([
      { body: withContext(5000) },
      { body: withContext(5004, "testnet", 380000) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByTestId("transparency-context")).toHaveTextContent("testnet · ledger 5,000"));
    expect(urls[0]).toContain("network=testnet");
    expect(urls[0]).not.toContain("minLedger");

    fireEvent.click(screen.getByRole("button", { name: /Refresh transparency data/i }));
    await waitFor(() => expect(screen.getByText("$380,000")).toBeInTheDocument());
    expect(urls[1]).toContain("minLedger=5000");
    expect(screen.getByTestId("transparency-context")).toHaveTextContent("ledger 5,004");
  });

  it("keeps the figures on screen when a refresh comes from another network", async () => {
    const { fetchMock } = summarySequence([
      { body: withContext(5000) },
      { body: withContext(9000, "mainnet", 999999) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("$372,000")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Refresh transparency data/i }));
    await waitFor(() =>
      expect(screen.getByTestId("transparency-refresh-notice")).toHaveTextContent(/mainnet/),
    );
    expect(screen.getByText("$372,000")).toBeInTheDocument();
    expect(screen.queryByText("$999,999")).not.toBeInTheDocument();
    expect(screen.getByTestId("transparency-context")).toHaveTextContent("ledger 5,000");
  });

  it("keeps the newer snapshot when a refresh answers from an older ledger", async () => {
    const { fetchMock } = summarySequence([
      { body: withContext(5000) },
      { body: withContext(4000, "testnet", 1) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("$372,000")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Refresh transparency data/i }));
    await waitFor(() => expect(screen.getByTestId("transparency-refresh-notice")).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText("$372,000")).toBeInTheDocument();
    expect(screen.getByTestId("transparency-context")).toHaveTextContent("ledger 5,000");
  });

  it("retries while the server is behind the ledger shown, then shows the update", async () => {
    const { fetchMock } = summarySequence([
      { body: withContext(5000) },
      { status: 409, body: { code: "TRANSPARENCY_LEDGER_BEHIND", error: "behind", retryable: true } },
      { body: withContext(5001, "testnet", 390000) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("$372,000")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Refresh transparency data/i }));
    await waitFor(() => expect(screen.getByText("$390,000")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByTestId("transparency-refresh-notice")).not.toBeInTheDocument();
  });

  it("does not show data when the first read is for another network", async () => {
    const { fetchMock } = summarySequence([{ body: withContext(9000, "mainnet", 999999) }]);
    vi.stubGlobal("fetch", fetchMock);

    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("Unable to load data")).toBeInTheDocument());
    expect(screen.queryByText("$999,999")).not.toBeInTheDocument();
  });
});
