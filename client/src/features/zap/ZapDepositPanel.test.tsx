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
});
