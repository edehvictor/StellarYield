import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import WithdrawPanel from "./WithdrawPanel";
import { withdraw, getUserShares } from "../../services/soroban";

/**
 * Issue #1152 — graceful recovery for expired wallet connection sessions.
 *
 * Covers both protected flows named in the issue for the withdraw panel:
 *  - "quote preview": the share-balance read that backs the withdrawal
 *    preview (max amount, balance validation) requires a live session.
 *  - "transaction submission": the withdraw() call itself.
 * An expired session on either must surface typed recovery (reconnect /
 * cancel / retry) rather than an uncaught error or a silently stale/blank
 * preview, and a successful reconnect must resume the original action.
 */

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

// Deterministic withdrawal preview response so tests aren't dependent on
// this environment's VITE_API_BASE_URL / real network behavior.
vi.mock("../../lib/api", () => ({
  getApiBaseUrlOrNull: () => "http://localhost:3001",
  apiFetch: () =>
    Promise.resolve({
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
    }),
}));

const mockConnectWallet = vi.fn();
let mockIsSessionExpired = false;

vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: true,
    isSessionExpired: mockIsSessionExpired,
    connectWallet: mockConnectWallet,
    providerId: "freighter",
  }),
}));

const mockWithdraw = vi.mocked(withdraw);
const mockGetUserShares = vi.mocked(getUserShares);

/**
 * Types an amount and waits for the submit button to settle out of its
 * "Loading preview…" state (the debounced preview fetch/compute must
 * resolve first) rather than just waiting for preview text to appear,
 * since the two can update a tick apart.
 */
async function typeAmountAndAwaitReadyButton(amount: string) {
  const input = screen.getByPlaceholderText("0.00");
  await userEvent.type(input, amount);
  await waitFor(
    () => expect(screen.getByRole("button", { name: /^Withdraw$/i })).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe("WithdrawPanel session-expiry recovery (#1152)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSessionExpired = false;
    mockGetUserShares.mockResolvedValue(500_0000000n);
    mockConnectWallet.mockResolvedValue(true);
    mockWithdraw.mockResolvedValue({ success: true, hash: "0xhash" });
  });

  it("blocks the share-balance (preview) read and shows recovery when the session is already expired on mount", async () => {
    mockIsSessionExpired = true;

    render(<WithdrawPanel walletAddress="GABCDEF123" />);

    const recovery = await screen.findByTestId("session-expired-recovery");
    expect(recovery).toHaveTextContent(/Load withdrawal preview/);
    expect(mockGetUserShares).not.toHaveBeenCalled();
  });

  it("resumes the share-balance load after a successful reconnect", async () => {
    mockIsSessionExpired = true;
    render(<WithdrawPanel walletAddress="GABCDEF123" />);
    await screen.findByTestId("session-expired-recovery");

    mockConnectWallet.mockImplementation(async () => {
      mockIsSessionExpired = false;
      return true;
    });

    fireEvent.click(screen.getByRole("button", { name: /Reconnect & resume/i }));

    await waitFor(() => expect(mockGetUserShares).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Max: 500/)).toBeInTheDocument());
  });

  it("does not submit and shows recovery instead of an uncaught error when the session expires before withdrawal submission", async () => {
    const { rerender } = render(<WithdrawPanel walletAddress="GABCDEF123" />);
    await waitFor(() => expect(screen.getByText(/Max: 500/)).toBeInTheDocument());
    await typeAmountAndAwaitReadyButton("10");

    // Session expires between preview and submission. Re-render so the
    // component picks up the new useWallet() mock value.
    mockIsSessionExpired = true;
    rerender(<WithdrawPanel walletAddress="GABCDEF123" />);

    fireEvent.click(screen.getByRole("button", { name: /^Withdraw$/i }));

    const recovery = await screen.findByTestId("session-expired-recovery");
    expect(recovery).toHaveTextContent(/Withdraw/);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it("resumes the original withdrawal after a successful reconnect", async () => {
    const { rerender } = render(<WithdrawPanel walletAddress="GABCDEF123" />);
    await waitFor(() => expect(screen.getByText(/Max: 500/)).toBeInTheDocument());
    await typeAmountAndAwaitReadyButton("10");

    mockIsSessionExpired = true;
    rerender(<WithdrawPanel walletAddress="GABCDEF123" />);
    fireEvent.click(screen.getByRole("button", { name: /^Withdraw$/i }));
    await screen.findByTestId("session-expired-recovery");
    expect(mockWithdraw).not.toHaveBeenCalled();

    mockConnectWallet.mockImplementation(async () => {
      mockIsSessionExpired = false;
      return true;
    });

    fireEvent.click(screen.getByRole("button", { name: /Reconnect & resume/i }));

    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(1));
  });

  it("submits normally with no recovery UI when the session is valid", async () => {
    render(<WithdrawPanel walletAddress="GABCDEF123" />);
    await waitFor(() => expect(screen.getByText(/Max: 500/)).toBeInTheDocument());
    await typeAmountAndAwaitReadyButton("10");

    fireEvent.click(screen.getByRole("button", { name: /^Withdraw$/i }));

    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("session-expired-recovery")).not.toBeInTheDocument();
  });
});
