import { describe, it, expect } from "vitest";
import {
  getSourceStatusDisplay,
  formatLatency,
  formatAge,
  hasUnhealthySources,
  type SourceHealthRegistry,
} from "./sourceHealthStatus";

describe("getSourceStatusDisplay", () => {
  it("maps healthy to a non-attention success badge", () => {
    const display = getSourceStatusDisplay("healthy");
    expect(display.variant).toBe("success");
    expect(display.needsAttention).toBe(false);
    expect(display.label).toBe("Healthy");
  });

  it("maps degraded and stale to attention-worthy warning badges", () => {
    expect(getSourceStatusDisplay("degraded").variant).toBe("warning");
    expect(getSourceStatusDisplay("degraded").needsAttention).toBe(true);
    expect(getSourceStatusDisplay("stale").variant).toBe("warning");
    expect(getSourceStatusDisplay("stale").needsAttention).toBe(true);
  });

  it("maps unavailable to a danger badge", () => {
    const display = getSourceStatusDisplay("unavailable");
    expect(display.variant).toBe("danger");
    expect(display.needsAttention).toBe(true);
  });

  it("falls back to a neutral 'Unknown' badge for unexpected values", () => {
    const display = getSourceStatusDisplay("something-else");
    expect(display.variant).toBe("neutral");
    expect(display.label).toBe("Unknown");
  });
});

describe("formatLatency", () => {
  it("renders sub-second latency in ms", () => {
    expect(formatLatency(250)).toBe("250ms");
  });
  it("renders >=1s latency in seconds", () => {
    expect(formatLatency(1500)).toBe("1.50s");
  });
  it("renders a dash for invalid latency", () => {
    expect(formatLatency(-1)).toBe("—");
  });
});

describe("formatAge", () => {
  it("renders seconds, minutes, and hours", () => {
    expect(formatAge(30)).toBe("30s ago");
    expect(formatAge(120)).toBe("2m ago");
    expect(formatAge(7200)).toBe("2h ago");
  });
  it("renders 'unknown' for invalid age", () => {
    expect(formatAge(-1)).toBe("unknown");
  });
});

describe("hasUnhealthySources", () => {
  const registry = (
    counts: Partial<SourceHealthRegistry["counts"]>,
  ): SourceHealthRegistry => ({
    generatedAt: new Date().toISOString(),
    totalSources: 0,
    counts: { healthy: 0, degraded: 0, stale: 0, unavailable: 0, ...counts },
    sources: [],
  });

  it("is false when all sources are healthy", () => {
    expect(hasUnhealthySources(registry({ healthy: 3 }))).toBe(false);
  });

  it("is true when any source is degraded, stale, or unavailable", () => {
    expect(hasUnhealthySources(registry({ healthy: 2, stale: 1 }))).toBe(true);
    expect(hasUnhealthySources(registry({ unavailable: 1 }))).toBe(true);
  });
});
