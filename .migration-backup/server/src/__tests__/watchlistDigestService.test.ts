import {
  buildWatchlistDigestEvents,
  buildWatchlistDigestPreview,
} from "../services/digest/watchlistDigestService";
import type { WatchlistDigestPreference } from "../services/digest/types";

const preference: WatchlistDigestPreference = {
  enabled: true,
  scheduleMode: "event_threshold",
  eventThreshold: 2,
  watchedVaultIds: ["vault-1"],
  minApyDeltaPct: 0.5,
  minRiskDelta: 5,
  maxFreshnessHours: 12,
};

describe("watchlist digest content generation", () => {
  it("creates APY and risk digest events when thresholds are crossed", () => {
    const events = buildWatchlistDigestEvents(
      "wallet-1",
      preference,
      [
        {
          vaultId: "vault-1",
          apyPct: 8,
          riskScore: 42,
          freshnessHours: 4,
          alertTriggered: false,
        },
      ],
      [
        {
          vaultId: "vault-1",
          apyPct: 9.1,
          riskScore: 50,
          freshnessHours: 4,
          alertTriggered: false,
        },
      ],
    );

    expect(events.some((event) => event.trigger === "apy_change")).toBe(true);
    expect(events.some((event) => event.trigger === "risk_change")).toBe(true);
  });

  it("creates freshness and alert-triggered events when watch conditions trip", () => {
    const events = buildWatchlistDigestEvents(
      "wallet-1",
      preference,
      [
        {
          vaultId: "vault-1",
          apyPct: 8,
          riskScore: 42,
          freshnessHours: 2,
          alertTriggered: false,
        },
      ],
      [
        {
          vaultId: "vault-1",
          apyPct: 8.1,
          riskScore: 42,
          freshnessHours: 18,
          alertTriggered: true,
        },
      ],
    );

    expect(events.some((event) => event.trigger === "freshness_change")).toBe(true);
    expect(events.some((event) => event.trigger === "alert_triggered")).toBe(true);
  });

  it("returns no events when the watched vault list does not include the snapshot", () => {
    const events = buildWatchlistDigestEvents(
      "wallet-1",
      {
        ...preference,
        watchedVaultIds: ["vault-9"],
      },
      [
        {
          vaultId: "vault-1",
          apyPct: 8,
          riskScore: 42,
          freshnessHours: 2,
          alertTriggered: false,
        },
      ],
      [
        {
          vaultId: "vault-1",
          apyPct: 9,
          riskScore: 52,
          freshnessHours: 18,
          alertTriggered: true,
        },
      ],
    );

    expect(events).toHaveLength(0);
  });

  it("formats digest preview content with watchlist summaries", () => {
    const events = buildWatchlistDigestEvents(
      "wallet-1",
      preference,
      [
        {
          vaultId: "vault-1",
          apyPct: 8,
          riskScore: 42,
          freshnessHours: 2,
          alertTriggered: false,
        },
      ],
      [
        {
          vaultId: "vault-1",
          apyPct: 9,
          riskScore: 48,
          freshnessHours: 2,
          alertTriggered: false,
        },
      ],
    );

    const digest = buildWatchlistDigestPreview("wallet-1", "daily", events);
    expect(digest.clusters.length).toBeGreaterThan(0);
    expect(digest.clusters[0].eventType).toBe("watchlist");
    expect(digest.clusters[0].summary.length).toBeGreaterThan(0);
  });
});

