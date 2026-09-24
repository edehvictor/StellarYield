import { render, screen } from "@testing-library/react";
import { FreshnessBanner } from "../FreshnessBanner";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

describe("FreshnessBanner", () => {
  beforeAll(() => {
    // Mock Date.now to keep time stable for tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T09:20:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("renders fresh active state when lastUpdated is recent and confidence is high", () => {
    // Sync 1 minute ago (60000ms ago) -> should be fresh
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    render(<FreshnessBanner lastUpdated={oneMinAgo} confidence={0.95} />);

    expect(screen.getByText("Live Market Sync Active")).toBeInTheDocument();
    expect(screen.getByText("Fresh")).toBeInTheDocument();
    expect(screen.getByText(/Confidence score: 95%/i)).toBeInTheDocument();
  });

  it("renders stale state when lastUpdated is very old or confidence is low", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(<FreshnessBanner lastUpdated={oneHourAgo} confidence={0.3} />);

    expect(screen.getByText("Stale DeFi Market Data")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText(/Confidence score: 30%/i)).toBeInTheDocument();
  });

  it("renders appropriate fallback when lastUpdated is missing but isEstimated/isPartial is set", () => {
    render(<FreshnessBanner isEstimated />);
    expect(screen.getByText("Estimated System Projections")).toBeInTheDocument();
    expect(screen.getByText("Estimated / No Timestamp")).toBeInTheDocument();

    render(<FreshnessBanner isPartial />);
    expect(screen.getByText("Partial / Incomplete Yield Data")).toBeInTheDocument();
  });

  it("handles invalid timestamp gracefully with error banner", () => {
    render(<FreshnessBanner lastUpdated="invalid-date-string" />);
    expect(screen.getByText("Invalid timestamp provided for data freshness check.")).toBeInTheDocument();
  });

  it("renders cached-data banner for source=cache", () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    render(<FreshnessBanner lastUpdated={oneMinAgo} source="cache" />);

    expect(screen.getByTestId("cache-banner")).toBeInTheDocument();
    expect(screen.getByText("Showing Cached Data")).toBeInTheDocument();
    expect(screen.getByText("Cached")).toBeInTheDocument();
  });

  it("renders explicit offline indicator when isOffline is set", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(
      <FreshnessBanner lastUpdated={fiveMinAgo} source="cache" isOffline />,
    );

    const banner = screen.getByTestId("offline-cache-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("Offline — Showing Cached Data");
    expect(banner).toHaveTextContent("Offline");
    expect(screen.queryByText("Showing Cached Data")).not.toBeInTheDocument();
  });
});
