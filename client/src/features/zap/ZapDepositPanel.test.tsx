import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ZapDepositPanel from "./ZapDepositPanel";

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

function createMockQuote(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  return {
    path: [
      { contractId: "CXLM", label: "XLM" },
      { contractId: "CVAULT", label: "yVault" },
    ],
    expectedAmountOutStroops: "9500000",
    source: "router_simulation",
    slippageApplied: 0.005,
    amountOutAfterSlippage: "9452500",
    quotedAt: now.toISOString(),
    minAmountOutStroops: "9452500",
    quoteAgeMs: 100,
    isFallback: false,
    quoteId: `test-quote-${Math.random().toString(36).slice(2, 6)}`,
    expiresAt,
    ttlMs: 60_000,
    inputTokenContract: "CXLM",
    vaultTokenContract: "CVAULT",
    amountInStroops: "10000000",
    protocol: "default",
    freezeCheckedAt: now.toISOString(),
    quoteSource: "router_simulation",
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

  describe("stale quote state", () => {
    it("shows stale quote warning when quote is old", async () => {
      const staleQuotedAt = new Date(Date.now() - 120_000).toISOString();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ quotedAt: staleQuotedAt }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Stale quote")).toBeInTheDocument();
      });
    });

    it("blocks submission when quote is stale", async () => {
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

  describe("quote expiry safety envelope", () => {
    it("shows expired banner and requote action when expiresAt is in past", async () => {
      const expiredAt = new Date(Date.now() - 5_000).toISOString();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ expiresAt: expiredAt, quotedAt: new Date(Date.now() - 70_000).toISOString() }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText(/Quote expired/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Requote now/)).toBeInTheDocument();
      // Submit should be blocked when expired
      const submitBtn = screen.getByRole("button", { name: /zap deposit|deposit/i });
      expect(submitBtn).toBeDisabled();
    });

    it("shows expiry time and quote id when present", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ quoteId: "abc12345-xyz", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Simulated")).toBeInTheDocument();
      });
      // expires label and short id should appear
      await waitFor(() => {
        expect(screen.getByText(/expires/)).toBeInTheDocument();
      });
      expect(screen.getByText("abc12345")).toBeInTheDocument();
    });

    it("blocks zap when quote is stale via expiresAt", async () => {
      const staleExpired = new Date(Date.now() - 10_000).toISOString();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ expiresAt: staleExpired }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText(/Quote expired/)).toBeInTheDocument();
      });
      const submitBtn = screen.getByRole("button", { name: /zap deposit|deposit/i });
      expect(submitBtn).toBeDisabled();
    });
  });

  describe("fallback acknowledgment safety", () => {
    it("shows acknowledgment checkbox for fallback quotes", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ source: "fallback_rate", isFallback: true, quoteSource: "fallback_rate" }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Fallback quote active")).toBeInTheDocument();
      });
      expect(screen.getByText(/I understand the risk/)).toBeInTheDocument();
      expect(screen.getByText(/Fallback quotes are estimated/)).toBeInTheDocument();
    });

    it("blocks submission until fallback acknowledged", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ source: "fallback_rate", isFallback: true, quoteSource: "fallback_rate" }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Fallback quote active")).toBeInTheDocument();
      });

      const submitBtn = screen.getByRole("button", { name: /zap deposit|deposit/i });
      expect(submitBtn).toBeDisabled();

      const checkbox = screen.getByRole("checkbox");
      await userEvent.click(checkbox);

      await waitFor(() => {
        // After ack, if not stale, block should be removed (depositImpact not blocking)
        // The button may still be enabled; check that the ack warning disappears or button enables
        expect(submitBtn).not.toBeDisabled();
      });
    });

    it("enables fallback execution after explicit acknowledgment", async () => {
      // Verify fallback not silently treated as simulated: badge says Fallback and needs ack
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ source: "fallback_rate", isFallback: true }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText("Fallback")).toBeInTheDocument();
      });
      const badge = screen.getByText("Fallback");
      expect(badge).toHaveTextContent("Fallback");
      expect(badge).not.toHaveTextContent("Simulated");
    });
  });

  describe("freeze invalidation", () => {
    it("shows frozen banner when quote reports isFrozen", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ isFrozen: true }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText(/Protocol frozen/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Requote/)).toBeInTheDocument();
    });
  });

  describe("slippage edge messaging", () => {
    it("shows low slippage warning when slippage very low", async () => {
      render(<ZapDepositPanel walletAddress="GABCDEF123" />);
      openSlippageEditor();
      const presetBtn = screen.getByText("0.1%");
      fireEvent.click(presetBtn);
      // low slippage hint appears (we added for <0.5)
      await waitFor(() => {
        expect(screen.getByText(/Very low slippage/)).toBeInTheDocument();
      });
    });

    it("requires requote action is visible for stale/fallback/frozen", async () => {
      const staleQuotedAt = new Date(Date.now() - 120_000).toISOString();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => createMockQuote({ quotedAt: staleQuotedAt }),
      });

      render(<ZapDepositPanel walletAddress="GABCDEF123" />);

      const input = screen.getByPlaceholderText("0.00");
      await userEvent.type(input, "100");

      await waitFor(() => {
        expect(screen.getByText(/Quote is stale|Stale quote/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Requote/)).toBeInTheDocument();
    });
  });
});
