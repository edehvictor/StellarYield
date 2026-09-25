import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { DensityProvider, useDensity, loadDensity } from "../DensityContext";
import type { ReactNode } from "react";

function wrapper({ children }: { children: ReactNode }) {
  return <DensityProvider>{children}</DensityProvider>;
}

describe("DensityContext", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to comfortable when nothing is stored", () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    expect(result.current.density).toBe("comfortable");
    expect(result.current.densityClass).toBe("density-comfortable");
    expect(result.current.spacingScale).toBe(1);
    expect(result.current.fontScale).toBe(1);
  });

  it("reads stored density from localStorage", () => {
    localStorage.setItem("stellar-yield.density-mode", "compact");
    const { result } = renderHook(() => useDensity(), { wrapper });
    expect(result.current.density).toBe("compact");
    expect(result.current.densityClass).toBe("density-compact");
    expect(result.current.spacingScale).toBe(0.75);
  });

  it("persists density changes to localStorage", () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    act(() => {
      result.current.setDensity("spacious");
    });
    expect(result.current.density).toBe("spacious");
    expect(localStorage.getItem("stellar-yield.density-mode")).toBe("spacious");
  });

  it("returns compact font scale for compact mode", () => {
    localStorage.setItem("stellar-yield.density-mode", "compact");
    const { result } = renderHook(() => useDensity(), { wrapper });
    expect(result.current.fontScale).toBe(0.85);
  });

  it("returns spacious font scale for spacious mode", () => {
    localStorage.setItem("stellar-yield.density-mode", "spacious");
    const { result } = renderHook(() => useDensity(), { wrapper });
    expect(result.current.fontScale).toBe(1.1);
    expect(result.current.spacingScale).toBe(1.25);
  });
});

describe("loadDensity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns comfortable for empty localStorage", () => {
    expect(loadDensity()).toBe("comfortable");
  });

  it("returns compact when stored", () => {
    localStorage.setItem("stellar-yield.density-mode", "compact");
    expect(loadDensity()).toBe("compact");
  });

  it("returns comfortable for invalid stored value", () => {
    localStorage.setItem("stellar-yield.density-mode", "invalid");
    expect(loadDensity()).toBe("comfortable");
  });
});
