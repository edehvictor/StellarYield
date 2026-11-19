import { render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SourceHealthPanel from "./SourceHealthPanel";
import { buildCacheKey } from "../../lib/cachedFetch";
import { apiUrl } from "../../lib/api";

const registryBody = {
  data: {
    generatedAt: "2026-05-28T09:00:00Z",
    totalSources: 2,
    counts: { healthy: 1, degraded: 0, stale: 1, unavailable: 0 },
    sources: [
      {
        providerId: "p1",
        providerName: "Provider One",
        dataSource: "defi-llama",
        status: "healthy",
        reliabilityScore: 0.99,
        uptimePct: 99.9,
        freshnessPct: 0.98,
        errorRatePct: 0.1,
        latencyMs: 120,
        latestFetch: "2026-05-28T08:59:00Z",
        ageSeconds: 30,
        consecutiveFailures: 0,
        failureReason: null,
        trend: "stable",
      },
      {
        providerId: "p2",
        providerName: "Provider Two",
        dataSource: "stellartoken.io",
        status: "stale",
        reliabilityScore: 0.7,
        uptimePct: 90,
        freshnessPct: 0.5,
        errorRatePct: 5,
        latencyMs: 900,
        latestFetch: "2026-05-28T08:50:00Z",
        ageSeconds: 600,
        consecutiveFailures: 2,
        failureReason: "timeout",
        trend: "declining",
      },
    ],
  },
};

const cachePath = apiUrl("/api/analytics/sources/health");

/** Seed the persistent cache with a full API body (`{ data: ... }`). */
function seedCache(body: unknown = registryBody) {
  window.localStorage.setItem(
    buildCacheKey("GET", cachePath),
    JSON.stringify({ data: body, fetchedAt: Date.now() }),
  );
}

describe("SourceHealthPanel offline cache indicator", () => {
  const mockFetch = vi.fn();
  global.fetch = mockFetch;

  beforeEach(() => {
    mockFetch.mockReset();
    window.localStorage.clear();
  });

  it("renders cached registry with an offline banner when the network fails", async () => {
    seedCache();
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    render(<SourceHealthPanel />);

    const banner = await screen.findByTestId("offline-cache-banner");
    expect(banner).toHaveTextContent("Offline — Showing Cached Data");
    expect(screen.getByText("Provider One")).toBeInTheDocument();
    expect(screen.queryByText(/Loading source health/i)).not.toBeInTheDocument();
  });

  it("replaces cached data with fresh data after reconnect (online event)", async () => {
    seedCache();
    const freshBody = {
      data: {
        ...registryBody.data,
        sources: [
          {
            providerId: "p9",
            providerName: "Fresh Provider",
            dataSource: "api",
            status: "healthy",
            reliabilityScore: 1,
            uptimePct: 100,
            freshnessPct: 1,
            errorRatePct: 0,
            latencyMs: 42,
            latestFetch: "2026-05-28T09:30:00Z",
            ageSeconds: 1,
            consecutiveFailures: 0,
            failureReason: null,
            trend: "improving",
          },
        ],
      },
    };
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(freshBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<SourceHealthPanel />);
    await screen.findByTestId("offline-cache-banner");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(await screen.findByText("Fresh Provider")).toBeInTheDocument();
    expect(screen.queryByTestId("offline-cache-banner")).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("shows an error only when there is no cached data", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    render(<SourceHealthPanel />);

    expect(await screen.findByText("fetch failed")).toBeInTheDocument();
    expect(screen.queryByTestId("offline-cache-banner")).not.toBeInTheDocument();
  });
});
