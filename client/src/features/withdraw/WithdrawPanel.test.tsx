import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import WithdrawPanel from "./WithdrawPanel";
import { withdraw, getUserShares } from "../../services/soroban";
import { apiFetch } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(),
  getApiBaseUrlOrNull: () => "http://localhost:3001",
}));

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
const mockApiFetch = vi.mocked(apiFetch);

async function typeAmountAndAwaitReadyButton(amount: string) {
  const input = screen.getByPlaceholderText("0.00");
  await userEvent.type(input, amount);
  await waitFor(
    () => expect(screen.getByRole("button", { name: /^Withdraw$/i })).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe("WithdrawPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserShares.mockResolvedValue(500_0000000n);
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        vaultId: "usdc",
        requestedAmountUsd: 10,
        exitFeeUsd: 0,
        exitFeeBps: 0,
        processingDelayLabel: "Instant (~5 seconds on-chain)",
        processingDelaySeconds: 5,
        estimatedNetUsd: 10,
        optimisticNetUsd: 10,
        conservativeNetUsd: 10,
        priceImpactPct: 0,
        isLowLiquidity: false,
        quotedAt: new Date().toISOString(),
      }),
    } as Response);
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

    await typeAmountAndAwaitReadyButton("10");

    const button = screen.getByRole("button", { name: /^Withdraw$/i });
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

    await typeAmountAndAwaitReadyButton("10");
    fireEvent.click(screen.getByRole("button", { name: /^Withdraw$/i }));

    let dialog: HTMLElement;
    await waitFor(() => {
      dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
    });
    expect(within(dialog!).getByText(/Insufficient Shares/i)).toBeInTheDocument();
  });

  it("shows a low-reserve vault warning when the preview breaches the reserve buffer", async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        vaultId: "usdc",
        requestedAmountUsd: 10,
        exitFeeUsd: 0,
        exitFeeBps: 0,
        processingDelayLabel: "Instant (~5 seconds on-chain)",
        processingDelaySeconds: 5,
        estimatedNetUsd: 10,
        optimisticNetUsd: 10,
        conservativeNetUsd: 10,
        priceImpactPct: 0,
        isLowLiquidity: false,
        quotedAt: new Date().toISOString(),
        reserveImpact: {
          currentReserveRatioPct: 10,
          projectedReserveRatioPct: 4.5,
          projectedReserveUsd: 45000,
          breachesMinBuffer: true,
          minBufferPct: 8,
        },
      }),
    } as Response);

    render(<WithdrawPanel walletAddress="GABCDEF123" />);

    await typeAmountAndAwaitReadyButton("10");

    expect(await screen.findByText(/low reserve detected/i)).toBeInTheDocument();
    expect(screen.getByText(/projected reserve ratio/i)).toBeInTheDocument();
  });

  it("rejects an amount exceeding the loaded share balance without calling withdraw", async () => {
    render(<WithdrawPanel walletAddress="GABCDEF123" />);

    await waitFor(() => {
      expect(screen.getByText(/Max: 500/)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("0.00");
    await userEvent.type(input, "999999");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Withdraw$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /^Withdraw$/i }));

    expect(screen.getByText(/exceeds your share balance/i)).toBeInTheDocument();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});
