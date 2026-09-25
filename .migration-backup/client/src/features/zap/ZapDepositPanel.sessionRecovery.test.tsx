import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ZapDepositPanel from "./ZapDepositPanel";

/**
 * Issue #1152 — graceful recovery for expired wallet connection sessions.
 *
 * Covers the "transaction submission" protected flow named in the issue:
 * a Zap deposit submitted while the wallet session is expired must not
 * throw uncaught or silently fail — it must surface a typed recovery state
 * (reconnect / cancel / retry), and a successful reconnect must resume the
 * originally-intended zap deposit rather than requiring the user to
 * re-enter everything.
 */

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("./assets", () => ({
  shouldLoadZapMetadataFromApi: () => false,
  getVaultTokenFromEnv: () => ({
    symbol: "yVault",
    name: "Yield Vault",
    contractId: "CVAULT",
    decimals: 7,
  }),
  getVaultContractIdFromEnv: () => "CVAULT",
  loadZapAssetOptions: () => [
    { symbol: "XLM", name: "Stellar", contractId: "CXLM", decimals: 7 },
    { symbol: "USDC", name: "USD Coin", contractId: "CUSDC", decimals: 7 },
  ],
  mergeVaultIntoZapSelectableAssets: (_assets: unknown[], vault: unknown) => [
    { symbol: "XLM", name: "Stellar", contractId: "CXLM", decimals: 7 },
    { symbol: "USDC", name: "USD Coin", contractId: "CUSDC", decimals: 7 },
    vault,
  ],
  buildSelectableZapAssetsFromMetadata: () => [],
  fetchZapSupportedAssetsMetadata: () => Promise.resolve(null),
}));

const mockZapDeposit = vi.fn().mockResolvedValue({ success: true, hash: "0xhash" });
vi.mock("../../services/soroban", () => ({
  zapDeposit: (...args: unknown[]) => mockZapDeposit(...args),
}));

vi.mock("../settings/SettingsContext", () => ({
  useSettings: () => ({ settings: {} }),
}));

vi.mock("../settings/types", () => ({
  resolveSlippage: () => 0.5,
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

function createMockQuote(overrides: Record<string, unknown> = {}) {
  return {
    path: [
      { contractId: "CXLM", label: "XLM" },
      { contractId: "CVAULT", label: "yVault" },
    ],
    expectedAmountOutStroops: "9500000",
    source: "router_simulation",
    slippageApplied: 0.005,
    amountOutAfterSlippage: "9452500",
    quotedAt: new Date().toISOString(),
    minAmountOutStroops: "9452500",
    quoteAgeMs: 100,
    isFallback: false,
    ...overrides,
  };
}

async function enterAmountAndAwaitQuote(amount: string) {
  const input = screen.getByPlaceholderText("0.00");
  await userEvent.type(input, amount);
  await waitFor(() => {
    expect(screen.getByText(/Min\. after/)).toBeInTheDocument();
  });
}

function mockFetchRoutes() {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/zap/verify")) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    }
    return Promise.resolve({ ok: true, json: async () => createMockQuote() });
  });
}

describe("ZapDepositPanel session-expiry recovery (#1152)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSessionExpired = false;
    mockFetchRoutes();
    mockZapDeposit.mockResolvedValue({ success: true, hash: "0xhash" });
    mockConnectWallet.mockResolvedValue(true);
  });

  it("does not submit and shows recovery instead of an uncaught error when the session is expired at submit time", async () => {
    const { rerender } = render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    await enterAmountAndAwaitQuote("100");

    // Session expires between quoting and clicking submit. Re-render so the
    // component picks up the new useWallet() mock value (mirrors a real
    // session-update triggering a WalletContext re-render).
    mockIsSessionExpired = true;
    rerender(<ZapDepositPanel walletAddress="GABCDEF123" />);

    fireEvent.click(screen.getByRole("button", { name: /Zap deposit/i }));

    const recovery = await screen.findByTestId("session-expired-recovery");
    expect(recovery).toHaveTextContent(/Zap deposit/);
    // The underlying submission must never have been attempted.
    expect(mockZapDeposit).not.toHaveBeenCalled();
  });

  it("resumes the original zap deposit after a successful reconnect", async () => {
    const { rerender } = render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    await enterAmountAndAwaitQuote("100");

    mockIsSessionExpired = true;
    rerender(<ZapDepositPanel walletAddress="GABCDEF123" />);
    fireEvent.click(screen.getByRole("button", { name: /Zap deposit/i }));
    await screen.findByTestId("session-expired-recovery");
    expect(mockZapDeposit).not.toHaveBeenCalled();

    // Reconnect succeeds and flips the session back to valid.
    mockConnectWallet.mockImplementation(async () => {
      mockIsSessionExpired = false;
      return true;
    });

    fireEvent.click(screen.getByRole("button", { name: /Reconnect & resume/i }));

    await waitFor(() => expect(mockZapDeposit).toHaveBeenCalledTimes(1));
    expect(mockConnectWallet).toHaveBeenCalledTimes(1);
  });

  it("discards the pending action and clears recovery state on cancel", async () => {
    const { rerender } = render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    await enterAmountAndAwaitQuote("100");

    mockIsSessionExpired = true;
    rerender(<ZapDepositPanel walletAddress="GABCDEF123" />);
    fireEvent.click(screen.getByRole("button", { name: /Zap deposit/i }));
    await screen.findByTestId("session-expired-recovery");

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("session-expired-recovery")).not.toBeInTheDocument(),
    );
    expect(mockZapDeposit).not.toHaveBeenCalled();

    // Confirms cancel didn't leave a stray resumed call in flight.
    mockIsSessionExpired = false;
    rerender(<ZapDepositPanel walletAddress="GABCDEF123" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockZapDeposit).not.toHaveBeenCalled();
  });

  it("submits normally with no recovery UI when the session is valid", async () => {
    render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    await enterAmountAndAwaitQuote("100");

    fireEvent.click(screen.getByRole("button", { name: /Zap deposit/i }));

    await waitFor(() => expect(mockZapDeposit).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("session-expired-recovery")).not.toBeInTheDocument();
  });
});
