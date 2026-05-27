import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import SettingsModal from "./SettingsModal";
import { SettingsProvider } from "./SettingsContext";
import { DEFAULT_TX_SETTINGS, SLIPPAGE_MAX } from "./types";

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

const Wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>{children}</SettingsProvider>
);

function renderModal(isOpen = true) {
  const onClose = vi.fn();
  render(
    <Wrapper>
      <SettingsModal isOpen={isOpen} onClose={onClose} />
    </Wrapper>,
  );
  return { onClose };
}

describe("SettingsModal", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it("renders nothing when isOpen is false", () => {
    renderModal(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the modal when isOpen is true", () => {
    renderModal();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Transaction settings")).toBeTruthy();
  });

  it("calls onClose when the close button is clicked", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByLabelText("Close settings"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when backdrop is clicked", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows Auto and Custom toggle buttons", () => {
    renderModal();
    expect(screen.getByText("Auto")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("shows custom input when Custom is selected", () => {
    renderModal();
    fireEvent.click(screen.getByText("Custom"));
    expect(screen.getByLabelText("Custom slippage percentage")).toBeTruthy();
  });

  it("shows error when custom slippage exceeds SLIPPAGE_MAX", () => {
    renderModal();
    fireEvent.click(screen.getByText("Custom"));
    const input = screen.getByLabelText("Custom slippage percentage");
    fireEvent.change(input, { target: { value: String(SLIPPAGE_MAX + 1) } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Maximum is");
  });

  it("shows high slippage warning for values above 1%", () => {
    renderModal();
    fireEvent.click(screen.getByText("Custom"));
    const input = screen.getByLabelText("Custom slippage percentage");
    fireEvent.change(input, { target: { value: "2.0" } });
    const alerts = screen.getAllByRole("alert");
    const warningAlert = alerts.find((a) => a.textContent?.includes("front-run"));
    expect(warningAlert).toBeTruthy();
  });

  it("shows error for invalid deadline", () => {
    renderModal();
    const deadlineInput = screen.getByLabelText("Transaction deadline in minutes");
    fireEvent.change(deadlineInput, { target: { value: "0" } });
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("Minimum"))).toBe(true);
  });

  it("resets to defaults when Reset button is clicked", () => {
    renderModal();
    // Change to custom first
    fireEvent.click(screen.getByText("Custom"));
    // Reset
    fireEvent.click(screen.getByText(/Reset to defaults/i));
    // Should be back to auto
    const autoBtn = screen.getByText("Auto");
    expect(autoBtn.className).toContain("bg-indigo-500");
  });

  it("shows the deadline input with default value", () => {
    renderModal();
    const deadlineInput = screen.getByLabelText("Transaction deadline in minutes") as HTMLInputElement;
    expect(deadlineInput.value).toBe(String(DEFAULT_TX_SETTINGS.deadlineMinutes));
  });
});
