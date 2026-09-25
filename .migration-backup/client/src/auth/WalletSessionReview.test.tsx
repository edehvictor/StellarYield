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

vi.mock("./session", () => ({
  loadStoredSession: vi.fn(() => ({
    walletAddress: "GABC1234",
    walletAddressType: "account",
    providerId: "freighter",
    providerLabel: "Freighter",
    verificationStatus: "verified",
    connectedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastVerifiedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    permissions: ["read", "sign", "trade"],
    origin: { tabId: "test-tab-1", origin: "https://stellar.yield" },
    providerAvailable: true,
  })),
  clearStoredSession: vi.fn(),
  isSessionExpired: vi.fn(() => false),
  isSessionStale: vi.fn(() => false),
  onSessionEvent: vi.fn(() => vi.fn()),
}));

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

  it("shows stale warning", async () => {
    const { isSessionStale } = await import("./session");
    vi.mocked(isSessionStale).mockReturnValue(true);

    mockUseWallet.lastActivityAt = new Date(Date.now() - 40 * 60_000).toISOString();
    render(<WalletSessionReview />);
    expect(screen.getByText(/Session appears stale/)).toBeTruthy();
    mockUseWallet.lastActivityAt = new Date(Date.now() - 5 * 60_000).toISOString();
    vi.mocked(isSessionStale).mockReturnValue(false);
  });

  it("supports disconnect action", () => {
    render(<WalletSessionReview />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(mockUseWallet.disconnectWallet).toHaveBeenCalled();
  });

  it("displays session origin information", () => {
    render(<WalletSessionReview />);
    expect(screen.getByText(/Session Origin/)).toBeTruthy();
    expect(screen.getByText(/test-tab-1/)).toBeTruthy();
  });

  it("displays permission review section", () => {
    render(<WalletSessionReview />);
    expect(screen.getByText(/Active Permissions/)).toBeTruthy();
  });

  it("expands permission details when clicked", () => {
    render(<WalletSessionReview />);
    const permButton = screen.getByText(/Active Permissions/).closest("button")!;
    fireEvent.click(permButton);
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Sign")).toBeTruthy();
    expect(screen.getByText("Trade")).toBeTruthy();
  });

  it("shows verification status badge", () => {
    render(<WalletSessionReview />);
    expect(screen.getByText("✓ Verified")).toBeTruthy();
  });

  it("shows last verified time", () => {
    render(<WalletSessionReview />);
    expect(screen.getByText("Last Verified:")).toBeTruthy();
  });
});
