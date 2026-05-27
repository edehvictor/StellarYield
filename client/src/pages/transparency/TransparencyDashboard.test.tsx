import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TransparencyDashboard from "../TransparencyDashboard";

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

function makeFetchMock(incidents: unknown[]) {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes("failover-history")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ incidents }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => mockTransparencyData,
    });
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

describe("TransparencyDashboard – failover incident history", () => {
  it("shows 'No failover incidents recorded' when history is empty", async () => {
    vi.stubGlobal("fetch", makeFetchMock([]));
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
    vi.stubGlobal("fetch", makeFetchMock(incidents));
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
    vi.stubGlobal("fetch", makeFetchMock(incidents));
    render(<TransparencyDashboard />);
    await waitFor(() => expect(screen.getByText("Soroswap")).toBeInTheDocument());
    expect(screen.getByText("Recovered")).toBeInTheDocument();
    expect(screen.getByText(/300s outage/i)).toBeInTheDocument();
  });
});
