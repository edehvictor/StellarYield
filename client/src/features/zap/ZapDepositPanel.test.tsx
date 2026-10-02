import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ZapDepositPanel from "./ZapDepositPanel";
import { zapDeposit } from "../../services/soroban";

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

vi.mock("../../services/soroban", () => ({
  zapDeposit: vi.fn().mockResolvedValue({ success: true, hash: "0xhash" }),
}));

vi.mock("../settings/SettingsContext", () => ({
  useSettings: () => ({
    settings: {},
  }),
}));

vi.mock("../settings/types", () => ({
  resolveSlippage: () => 0.5,
}));

// ZapDepositPanel is wallet-address-prop-driven, but the #1152 session-expiry
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

function openSlippageEditor() {
  const infoButton = screen.getByRole("button", { name: "" });
  fireEvent.click(infoButton);
}

describe("ZapDepositPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fresh quote state", () => {
    it("renders quote preview with simulated source badge", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote(),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Simulated")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByText(/Min\. after/)).toBeInTheDocument();
      });
    });

    it("shows vault token symbol in expected output", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote(),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText(/yVault/)).toBeInTheDocument();
      });
    });
  });

  describe("fallback quote state", () => {
    it("shows fallback warning badge", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ source: "fallback_rate", isFallback: true }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Fallback quote active")).toBeInTheDocument();
      });
    });

    it("shows Fallback badge for fallback source", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ source: "fallback_rate", isFallback: true }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        const fallbackBadge = screen.getByText("Fallback");
        expect(fallbackBadge).toBeInTheDocument();
      });
    });
  });

  describe("expired quote state", () => {
    it("shows the expired invalidation banner when the quote TTL has elapsed", async () => {
      const staleQuotedAt = new Date(Date.now() - 120_000).toISOString();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ quotedAt: staleQuotedAt }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Quote expired")).toBeInTheDocument();
      });

      const banner = screen
        .getAllByRole("alert")
        .find((el) => el.textContent?.includes("Quote expired"));
      expect(banner).toBeTruthy();
      expect(
        within(banner!).getByRole("button", { name: /refresh quote/i }),
      ).toBeInTheDocument();
    });

    it("blocks submission when quote has expired", async () => {
      const staleQuotedAt = new Date(Date.now() - 120_000).toISOString();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ quotedAt: staleQuotedAt }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Deposit blocked")).toBeInTheDocument();
      });

      const submitBtn = screen.getByRole("button", { name: /zap deposit|deposit/i });
      expect(submitBtn).toBeDisabled();
    });
  });

  describe("server-side quote invalidation on verify", () => {
    function mockFreshQuoteThenVerify(
      verifyBody: { error: string; message: string; recoverable?: boolean },
    ) {
      mockFetch.mockImplementation((url: string) => {
        if (String(url).includes("/api/zap/verify")) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: async () => verifyBody,
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () =>
            createMockQuote({
              quotedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
        });
      });
    }

    it("invalidates the preview and shows the deterministic STALE_QUOTE message", async () => {
      mockFreshQuoteThenVerify({
        error: "STALE_QUOTE",
        message: "Quote has expired",
        recoverable: true,
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Simulated")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /zap deposit/i }));

      await waitFor(() => {
        expect(
          screen.getByText("Quote expired. Refresh and try again."),
        ).toBeInTheDocument();
      });

      // Preview hard-invalidated: expected output cleared to the empty state.
      await waitFor(() => {
        expect(screen.getByText("—")).toBeInTheDocument();
      });
      expect(
        screen.queryByText("Min. after", { exact: false }),
      ).not.toBeInTheDocument();

      // Server flagged the failure recoverable → retry action is offered.
      expect(
        screen.getByRole("button", { name: /retry quote/i }),
      ).toBeInTheDocument();
    });

    it("shows the deterministic CONFIG_DRIFT message without echoing server text", async () => {
      mockFreshQuoteThenVerify({
        error: "CONFIG_DRIFT",
        message: "Asset configuration has drifted",
        recoverable: true,
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Simulated")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /zap deposit/i }));

      await waitFor(() => {
        expect(
          screen.getByText("Supported assets changed. Refresh and try again."),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText("Asset configuration has drifted"),
      ).not.toBeInTheDocument();
    });
  });

  describe("on-chain quote deadline", () => {
    const EXPIRES_AT = "2099-01-01T00:01:00.500Z";

    function mockFreshQuoteThenVerifyOk() {
      mockFetch.mockImplementation((url: string) => {
        if (String(url).includes("/api/zap/verify")) {
          return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
        }
        return Promise.resolve({
          ok: true,
          json: async () =>
            createMockQuote({ quotedAt: new Date().toISOString(), expiresAt: EXPIRES_AT }),
        });
      });
    }

    async function submitZap() {
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);
      await userEvent.type(screen.getByPlaceholderText("0.00"), "100");
      await waitFor(() => expect(screen.getByText("Simulated")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: /zap deposit/i }));
    }

    it("binds the transaction to the quote expiresAt (floored seconds)", async () => {
      mockFreshQuoteThenVerifyOk();
      vi.mocked(zapDeposit).mockResolvedValueOnce({ success: true, hash: "0xhash" });

      await submitZap();

      await waitFor(() => expect(zapDeposit).toHaveBeenCalledTimes(1));
      const params = vi.mocked(zapDeposit).mock.calls[0][1];
      expect(params.deadlineUnixSeconds).toBe(
        BigInt(Math.floor(Date.parse(EXPIRES_AT) / 1000)),
      );
      expect(params.expectedAmountOut).toBe(9_500_000n);
      expect(params.allowPartial).toBe(true);
    });

    it("invalidates the preview when the contract rejects with QuoteExpired (4001)", async () => {
      mockFreshQuoteThenVerifyOk();
      vi.mocked(zapDeposit).mockResolvedValueOnce({
        success: false,
        error: "Contract Execution Error [4001 Unknown]: ...",
        errorCode: 4001,
      });

      await submitZap();

      await waitFor(() => {
        expect(screen.getByText("Quote expired. Refresh and try again.")).toBeInTheDocument();
      });
      expect(screen.queryByText("Min. after", { exact: false })).not.toBeInTheDocument();
      expect(screen.queryByText(/Contract Execution Error/)).not.toBeInTheDocument();
    });
  });

  describe("no wallet state", () => {
    it("shows connect wallet prompt when no wallet", () => {
      render(<ZapDepositPanel walletAddress={null} />);
      expect(screen.getByText(/Connect your wallet/)).toBeInTheDocument();
    });
  });

  describe("slippage adjustment", () => {
    it("shows slippage tolerance display", async () => {
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);
      expect(screen.getByText(/Slippage tolerance/)).toBeInTheDocument();
    });

    it("allows opening slippage editor", async () => {
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      openSlippageEditor();

      await waitFor(() => {
        expect(screen.getByText(/Safe range/)).toBeInTheDocument();
      });
    });

    it("shows warning for high slippage", async () => {
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      openSlippageEditor();

      const presetBtn = screen.getByText("5%");
      fireEvent.click(presetBtn);

      await waitFor(() => {
        expect(screen.getByText(/High slippage/)).toBeInTheDocument();
      });
    });

    it("clamps slippage within safe bounds", async () => {
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      openSlippageEditor();

      const presetBtns = screen.getAllByRole("button");
      const hasPresetBtn = presetBtns.some((btn) => btn.textContent === "0.1%");
      expect(hasPresetBtn).toBe(true);
    });
  });

  describe("invalid quote state", () => {
    it("shows error on fetch failure", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });
  });

  describe("failed preview recovery actions", () => {
    it("shows recovery links for recoverable preview failures and retries", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          error: "QUOTE_FAILED",
          message: "Router simulation unavailable.",
          requestId: "req-1",
          recoverable: true,
        }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Router simulation unavailable.")).toBeInTheDocument();
      });

      expect(screen.getByRole("link", { name: /view account on explorer/i })).toHaveAttribute(
        "href",
        "https://stellar.expert/explorer/testnet/account/GABCDEF123",
      );
      expect(screen.getByRole("link", { name: /contact support/i })).toHaveAttribute(
        "href",
        "https://github.com/edehvictor/StellarYield/issues",
      );

      const callsBeforeRetry = mockFetch.mock.calls.length;
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => createMockQuote(),
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: /retry quote/i }));

      await waitFor(() => {
        expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
      });
      await waitFor(() => {
        expect(screen.getByText("Simulated")).toBeInTheDocument();
      });
    });

    it("hides recovery links for non-recoverable preview failures", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: "INVALID_AMOUNT",
          message: "amountInStroops must be an integer string.",
        }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(
          screen.getByText("amountInStroops must be an integer string."),
        ).toBeInTheDocument();
      });

      expect(screen.queryByRole("link", { name: /view account on explorer/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /contact support/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /retry quote/i })).not.toBeInTheDocument();
    });
  });

  describe("per-vault preferences", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("saves custom slippage to localStorage per vault and updates view", async () => {
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);
      openSlippageEditor();

      const presetBtn = screen.getByText("2%");
      fireEvent.click(presetBtn);

      await waitFor(() => {
        expect(screen.getAllByText("2%").length).toBeGreaterThan(0);
      });

      const stored = localStorage.getItem("vault_slippage_CVAULT");
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored!).slippage).toBe(2);
    });

    it("loads slippage from localStorage for matching vault contract", async () => {
      localStorage.setItem("vault_slippage_CVAULT", JSON.stringify({ slippage: 3.5 }));
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      await waitFor(() => {
        expect(screen.getAllByText("3.5%").length).toBeGreaterThan(0);
      });
    });

    it("ignores malformed persisted values and uses default", async () => {
      localStorage.setItem("vault_slippage_CVAULT", "{bad json}");
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      await waitFor(() => {
        expect(screen.getAllByText("0.5%").length).toBeGreaterThan(0);
      });
    });

    it("resets slippage tolerance to default on Reset click", async () => {
      localStorage.setItem("vault_slippage_CVAULT", JSON.stringify({ slippage: 4.5 }));
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      await waitFor(() => {
        expect(screen.getAllByText("4.5%").length).toBeGreaterThan(0);
      });

      openSlippageEditor();
      const resetBtn = screen.getByText("Reset");
      fireEvent.click(resetBtn);

      await waitFor(() => {
        expect(screen.getAllByText("0.5%").length).toBeGreaterThan(0);
      });
      expect(localStorage.getItem("vault_slippage_CVAULT")).toBeNull();
    });
  });
});
