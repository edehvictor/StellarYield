import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WalletSessionReview from "./WalletSessionReview";

const mockUseWallet = {
  isConnected: true,
  walletAddress: "GABC1234",
  providerLabel: "Freighter",
  providerId: "freighter",
  network: "mainnet",
  connectedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  disconnectWallet: vi.fn(),
  connectWallet: vi.fn().mockResolvedValue(true),
};

vi.mock("../context/useWallet", () => ({ useWallet: () => mockUseWallet }));

describe("WalletSessionReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders connected state details", () => {
    render(<WalletSessionReview />);
    expect(screen.getByText("Wallet Session Review")).toBeTruthy();
    expect(screen.getByText(/Freighter/)).toBeTruthy();
    expect(screen.getByText(/mainnet/)).toBeTruthy();
  });

  it("renders disconnected state", () => {
    mockUseWallet.isConnected = false;
    render(<WalletSessionReview />);
    expect(screen.getByText(/No active wallet session/)).toBeTruthy();
    mockUseWallet.isConnected = true;
  });

  it("shows stale warning", () => {
    mockUseWallet.lastActivityAt = new Date(Date.now() - 40 * 60_000).toISOString();
    render(<WalletSessionReview />);
    expect(screen.getByText(/Session appears stale/)).toBeTruthy();
    mockUseWallet.lastActivityAt = new Date(Date.now() - 5 * 60_000).toISOString();
  });

  it("supports disconnect action", () => {
    render(<WalletSessionReview />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(mockUseWallet.disconnectWallet).toHaveBeenCalled();
  });
});
