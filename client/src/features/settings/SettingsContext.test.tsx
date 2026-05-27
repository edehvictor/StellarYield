import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { SettingsProvider, useSettings } from "./SettingsContext";
import { DEFAULT_TX_SETTINGS, SLIPPAGE_MAX, SLIPPAGE_MIN, DEADLINE_MAX, DEADLINE_MIN } from "./types";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

const wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>{children}</SettingsProvider>
);

describe("useSettings", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  it("throws when used outside SettingsProvider", () => {
    // Suppress React error boundary noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSettings())).toThrow(
      "useSettings must be used within <SettingsProvider>",
    );
    spy.mockRestore();
  });

  it("returns DEFAULT_TX_SETTINGS on first render", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    expect(result.current.settings).toEqual(DEFAULT_TX_SETTINGS);
  });

  it("updateSettings merges partial patch", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => {
      result.current.updateSettings({ slippageMode: "custom", customSlippagePct: 1.0 });
    });
    expect(result.current.settings.slippageMode).toBe("custom");
    expect(result.current.settings.customSlippagePct).toBe(1.0);
    // Other fields unchanged
    expect(result.current.settings.deadlineMinutes).toBe(DEFAULT_TX_SETTINGS.deadlineMinutes);
  });

  it("clamps customSlippagePct to SLIPPAGE_MAX", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => {
      result.current.updateSettings({ customSlippagePct: 99 });
    });
    expect(result.current.settings.customSlippagePct).toBe(SLIPPAGE_MAX);
  });

  it("clamps customSlippagePct to SLIPPAGE_MIN", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => {
      result.current.updateSettings({ customSlippagePct: -5 });
    });
    expect(result.current.settings.customSlippagePct).toBe(SLIPPAGE_MIN);
  });

  it("clamps deadlineMinutes to DEADLINE_MAX", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => {
      result.current.updateSettings({ deadlineMinutes: 999 });
    });
    expect(result.current.settings.deadlineMinutes).toBe(DEADLINE_MAX);
  });

  it("clamps deadlineMinutes to DEADLINE_MIN", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => {
      result.current.updateSettings({ deadlineMinutes: 0 });
    });
    expect(result.current.settings.deadlineMinutes).toBe(DEADLINE_MIN);
  });

  it("resetSettings restores defaults", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => {
      result.current.updateSettings({ slippageMode: "custom", customSlippagePct: 3.0, deadlineMinutes: 5 });
    });
    act(() => {
      result.current.resetSettings();
    });
    expect(result.current.settings).toEqual(DEFAULT_TX_SETTINGS);
  });

  it("persists settings to localStorage", () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    act(() => {
      result.current.updateSettings({ deadlineMinutes: 15 });
    });
    const stored = JSON.parse(localStorageMock.getItem("stellar_yield_tx_settings") ?? "{}");
    expect(stored.deadlineMinutes).toBe(15);
  });

  it("loads persisted settings from localStorage on mount", () => {
    localStorageMock.setItem(
      "stellar_yield_tx_settings",
      JSON.stringify({ ...DEFAULT_TX_SETTINGS, slippageMode: "custom", customSlippagePct: 2.5 }),
    );
    const { result } = renderHook(() => useSettings(), { wrapper });
    expect(result.current.settings.slippageMode).toBe("custom");
    expect(result.current.settings.customSlippagePct).toBe(2.5);
  });

  it("falls back to defaults when localStorage has invalid JSON", () => {
    localStorageMock.setItem("stellar_yield_tx_settings", "not-json");
    const { result } = renderHook(() => useSettings(), { wrapper });
    expect(result.current.settings).toEqual(DEFAULT_TX_SETTINGS);
  });
});
