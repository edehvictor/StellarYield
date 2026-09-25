import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WalletProvider } from "../WalletContext";
import { useWallet } from "../useWallet";
import {
  saveTransactionDraft,
  getTransactionDraft,
  clearPendingTransactionDrafts,
  clearSensitiveWalletState,
  DRAFT_STORAGE_KEY,
} from "../../services/transactionDraft";

// Mock freighter api
vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
}));

// Mock wallet adapters
vi.mock("../../auth/walletAdapters", () => ({
  getAdapter: vi.fn().mockReturnValue({
    isAvailable: vi.fn().mockResolvedValue(true),
    getPublicKey: vi.fn().mockResolvedValue("GACCOUNT_A"),
    signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
  }),
}));

function ConsumerComponent() {
  const { isConnected, walletAddress, connectWallet, disconnectWallet } = useWallet();
  return (
    <div>
      <span data-testid="status">{isConnected ? "connected" : "disconnected"}</span>
      <span data-testid="address">{walletAddress || "none"}</span>
      <button onClick={() => void connectWallet({ providerId: "freighter" })}>
        Connect
      </button>
      <button onClick={() => disconnectWallet()}>Disconnect</button>
    </div>
  );
}

describe("Wallet Disconnect & State Cleanup (#1046)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("clears pending transaction drafts when active wallet disconnects", async () => {
    const { getAdapter } = await import("../../auth/walletAdapters");
    (getAdapter as any)().getPublicKey.mockResolvedValue("GACCOUNT_A");

    render(
      <WalletProvider>
        <ConsumerComponent />
      </WalletProvider>,
    );

    // 1. Connect Account A
    await act(async () => {
      fireEvent.click(screen.getByText("Connect"));
    });
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
    expect(screen.getByTestId("address")).toHaveTextContent("GACCOUNT_A");

    // 2. Set safe preferences and sensitive drafts
    localStorage.setItem("stellar_yield_tx_settings", JSON.stringify({ customSlippagePct: 1.5 }));
    localStorage.setItem("stellar_yield_ui_density", "compact");
    saveTransactionDraft("GACCOUNT_A", {
      id: "draft-1",
      action: "deposit",
      amount: 100,
      status: "draft",
    });

    expect(getTransactionDraft("GACCOUNT_A")).not.toBeNull();

    // 3. Disconnect Wallet
    await act(async () => {
      fireEvent.click(screen.getByText("Disconnect"));
    });

    // 4. Assert drafts and sensitive tokens are cleared, but UI preferences survive
    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
    expect(getTransactionDraft("GACCOUNT_A")).toBeNull();
    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("authToken")).toBeNull();

    // Verify safe preferences are preserved
    expect(localStorage.getItem("stellar_yield_tx_settings")).toContain("1.5");
    expect(localStorage.getItem("stellar_yield_ui_density")).toBe("compact");
  });

  it("clears pending draft on account switch and does not leak to new account", async () => {
    const { getAdapter } = await import("../../auth/walletAdapters");
    const adapter = (getAdapter as any)();

    render(
      <WalletProvider>
        <ConsumerComponent />
      </WalletProvider>,
    );

    // 1. Connect Account A
    adapter.getPublicKey.mockResolvedValue("GACCOUNT_A");
    await act(async () => {
      fireEvent.click(screen.getByText("Connect"));
    });
    expect(screen.getByTestId("address")).toHaveTextContent("GACCOUNT_A");

    // 2. Create draft for Account A
    saveTransactionDraft("GACCOUNT_A", {
      id: "draft-A",
      action: "swap",
      amount: 500,
      status: "draft",
    });
    expect(getTransactionDraft("GACCOUNT_A")?.id).toBe("draft-A");

    // 3. Switch account to Account B and reconnect
    adapter.getPublicKey.mockResolvedValue("GACCOUNT_B");
    await act(async () => {
      fireEvent.click(screen.getByText("Connect"));
    });
    expect(screen.getByTestId("address")).toHaveTextContent("GACCOUNT_B");

    // 4. Account B should NOT see Account A's draft
    expect(getTransactionDraft("GACCOUNT_B")).toBeNull();
    expect(getTransactionDraft("GACCOUNT_A")).toBeNull();
  });

  it("does not reuse stale payloads on reconnect", async () => {
    const { getAdapter } = await import("../../auth/walletAdapters");
    const adapter = (getAdapter as any)();
    adapter.getPublicKey.mockResolvedValue("GACCOUNT_A");

    render(
      <WalletProvider>
        <ConsumerComponent />
      </WalletProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Connect"));
    });

    saveTransactionDraft("GACCOUNT_A", {
      id: "draft-1",
      action: "deposit",
      payload: "stale_xdr_payload_12345",
      status: "ready",
    });

    // Disconnect
    await act(async () => {
      fireEvent.click(screen.getByText("Disconnect"));
    });

    // Reconnect Account A
    await act(async () => {
      fireEvent.click(screen.getByText("Connect"));
    });

    // Draft is gone, cannot reuse stale payload
    const draft = getTransactionDraft("GACCOUNT_A");
    expect(draft).toBeNull();
  });
});
