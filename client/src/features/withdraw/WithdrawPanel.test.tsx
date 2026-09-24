import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import WithdrawPanel from "./WithdrawPanel";
import { withdraw, getUserShares } from "../../services/soroban";

vi.mock("../../services/soroban", () => ({
  withdraw: vi.fn(),
  getUserShares: vi.fn(),
}));

vi.mock("../zap/assets", () => ({
  getVaultTokenFromEnv: () => ({
    symbol: "yVault",
    name: "Yield Vault",
    contractId: "CVAULT",
    decimals: 7,
  }),
}));

// WithdrawPanel is wallet-address-prop-driven, but the #1152 session-expiry
// recovery hook reads live session state via useWallet(). In production
// WalletProvider always wraps the app (see main.tsx); tests mock the hook
// directly to keep this file's render calls context-free.
vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: true,
    isSessionExpired: false,
    connectWallet: vi.fn().mockResolvedValue(true),
    providerId: "freighter",
  }),
}));

const mockWithdraw = vi.mocked(withdraw);
const mockGetUserShares = vi.mocked(getUserShares);

describe("WithdrawPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserShares.mockResolvedValue(500_0000000n);
  });

  it("prompts for wallet connection when no wallet address is provided", () => {
    render(<WithdrawPanel walletAddress={null} />);
    expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument();
  });

  it("loads and displays the user's share balance as the max amount", async () => {
    render(<WithdrawPanel walletAddress="GABCDEF123" />);

    await waitFor(() => {
      expect(screen.getByText(/Max: 500/)).toBeInTheDocument();
    });
  });

  it("drives the shared TxStatusTimeline through onPhase callbacks on success", async () => {
    mockWithdraw.mockImplementation(async (_addr, _shares, onPhase) => {
      onPhase?.("simulating");
      onPhase?.("waiting_for_wallet");
      onPhase?.("submitting");
      onPhase?.("polling");
      onPhase?.("success");
      return { success: true, hash: "deadbeef" };
    });

    render(<WithdrawPanel walletAddress="GABCDEF123" />);

    const input = screen.getByPlaceholderText("0.00");
    await userEvent.type(input, "10");

    const button = screen.getByRole("button", { name: /withdraw/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockWithdraw).toHaveBeenCalledWith(
        "GABCDEF123",
        100_000_000n,
        expect.any(Function),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/deadbeef/)).toBeInTheDocument();
    });
  });

  it("shows the failure modal with recovery guidance when withdraw fails", async () => {
    mockWithdraw.mockImplementation(async (_addr, _shares, onPhase) => {
      onPhase?.("simulating");
      onPhase?.("failure");
      return { success: false, error: "Error(Contract, #4)" };
    });

    render(<WithdrawPanel walletAddress="GABCDEF123" />);

    const input = screen.getByPlaceholderText("0.00");
    await userEvent.type(input, "10");
    fireEvent.click(screen.getByRole("button", { name: /withdraw/i }));

    let dialog: HTMLElement;
    await waitFor(() => {
      dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
    });
    expect(within(dialog!).getByText(/Insufficient Shares/i)).toBeInTheDocument();
  });

  it("rejects an amount exceeding the loaded share balance without calling withdraw", async () => {
    render(<WithdrawPanel walletAddress="GABCDEF123" />);

    await waitFor(() => {
      expect(screen.getByText(/Max: 500/)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("0.00");
    await userEvent.type(input, "999999");
    fireEvent.click(screen.getByRole("button", { name: /withdraw/i }));

    expect(screen.getByText(/exceeds your share balance/i)).toBeInTheDocument();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});
