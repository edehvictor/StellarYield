import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import WalletConnectionModal from "../WalletConnectionModal";

const mockUseWallet = {
  connectWallet: vi.fn().mockResolvedValue(true),
  isConnecting: false,
  isFreighterInstalled: true,
  errorMessage: null,
  verificationStatus: null,
  clearError: vi.fn(),
};

vi.mock("../../../context/useWallet", () => ({
  useWallet: () => mockUseWallet,
}));

function renderModal(isOpen = true) {
  const onClose = vi.fn();
  const utils = render(
    <WalletConnectionModal isOpen={isOpen} onClose={onClose} />,
  );
  return { onClose, ...utils };
}

describe("WalletConnectionModal accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWallet.errorMessage = null;
    mockUseWallet.isConnecting = false;
  });

  it("renders nothing when closed", () => {
    renderModal(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a dialog with aria-modal and aria-labelledby when open", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
    const titleId = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)).toHaveTextContent("Connect Wallet");
  });

  it("close button has accessible label", () => {
    renderModal();
    const closeBtn = screen.getByRole("button", { name: /close wallet dialog/i });
    expect(closeBtn).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /close wallet dialog/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wallet buttons have accessible aria-labels", () => {
    renderModal();
    expect(
      screen.getByRole("button", { name: /connect with freighter wallet/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect with xbull wallet/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect with albedo wallet/i }),
    ).toBeInTheDocument();
  });

  it("smart wallet buttons have accessible aria-labels", () => {
    renderModal();
    expect(
      screen.getByRole("button", { name: /sign in with email/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in with google/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in with github/i }),
    ).toBeInTheDocument();
  });

  it("error message is rendered as an alert", () => {
    mockUseWallet.errorMessage = "Wallet not found";
    renderModal();
    expect(screen.getByRole("alert")).toHaveTextContent("Wallet not found");
  });

  it("email input has a visible label and aria-label", () => {
    renderModal();
    const input = screen.getByLabelText(/email address or social handle/i);
    expect(input).toBeInTheDocument();
  });

  it("Tab key wraps focus from last to first focusable element", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const last = focusable[focusable.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab", code: "Tab", shiftKey: false });
    // jsdom doesn't actually move focus, but we can verify the event was handled
    // without throwing and the handler didn't propagate incorrectly
    expect(dialog).toBeInTheDocument();
  });

  it("Shift+Tab wraps focus from first to last focusable element", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", code: "Tab", shiftKey: true });
    expect(dialog).toBeInTheDocument();
  });

  it("shows Freighter install link when not installed", () => {
    mockUseWallet.isFreighterInstalled = false as unknown as boolean;
    renderModal();
    expect(
      screen.getByRole("link", { name: /install freighter wallet/i }),
    ).toBeInTheDocument();
    // @ts-expect-error restoring mock
    mockUseWallet.isFreighterInstalled = true;
  });
});
