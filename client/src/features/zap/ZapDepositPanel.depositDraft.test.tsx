import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ZapDepositPanel from "./ZapDepositPanel";
import { saveDepositDraft, loadDepositDraft, DEPOSIT_DRAFT_STALE_MS } from "./depositDraft";

/**
 * Issue #1146 — vault deposit replay checks for reloaded sessions.
 *
 * Simulates a page reload by rendering ZapDepositPanel fresh (no prior
 * in-memory state) with a deposit draft already sitting in localStorage —
 * exactly what a real reload looks like, since localStorage is the only
 * thing that survives a full page reload.
 */

const WALLET = "GABCDEF123";

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
  useSettings: () => ({ settings: {} }),
}));

vi.mock("../settings/types", () => ({
  resolveSlippage: () => 0.5,
}));

vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: true,
    isSessionExpired: false,
    connectWallet: vi.fn().mockResolvedValue(true),
    providerId: "freighter",
  }),
}));

function mockStatusFetch(status: "pending" | "confirmed", extra: Record<string, unknown> = {}) {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/deposits/status/")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ txHash: "deadbeef", status, ...extra }),
      });
    }
    // Any quote fetch in this suite is incidental; resolve harmlessly.
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ZapDepositPanel reload reconciliation (#1146)", () => {
  it("reload before any submission — no draft renders no resumed-state banner", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    render(<ZapDepositPanel walletAddress={WALLET} />);

    await waitFor(() => {
      expect(screen.queryByTestId("deposit-draft-pending")).not.toBeInTheDocument();
      expect(screen.queryByTestId("deposit-draft-confirmed")).not.toBeInTheDocument();
      expect(screen.queryByTestId("deposit-draft-stale")).not.toBeInTheDocument();
    });
  });

  it("reload before submission completed — a draft with no tx hash renders no banner and is cleared", async () => {
    saveDepositDraft(WALLET, {
      amount: "50",
      vaultContractId: "CVAULT",
      vaultTokenSymbol: "yVault",
      inputTokenContract: "CXLM",
      inputTokenSymbol: "XLM",
      submittedAt: Date.now(),
    });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    render(<ZapDepositPanel walletAddress={WALLET} />);

    await waitFor(() => {
      expect(screen.queryByTestId("deposit-draft-pending")).not.toBeInTheDocument();
    });
    expect(loadDepositDraft(WALLET)).toBeNull();
  });

  it("reload after submission but before confirmation — shows pending state from the persisted draft", async () => {
    saveDepositDraft(WALLET, {
      amount: "100",
      vaultContractId: "CVAULT",
      vaultTokenSymbol: "yVault",
      inputTokenContract: "CXLM",
      inputTokenSymbol: "XLM",
      txHash: "deadbeef",
      submittedAt: Date.now(),
    });
    mockStatusFetch("pending");

    render(<ZapDepositPanel walletAddress={WALLET} />);

    const banner = await screen.findByTestId("deposit-draft-pending");
    expect(banner).toHaveTextContent(/100 XLM/);
    expect(banner).toHaveTextContent(/yVault/);
    // Still persisted — not yet confirmed.
    expect(loadDepositDraft(WALLET)?.txHash).toBe("deadbeef");
  });

  it("reload after confirmation — shows the confirmed receipt state and cleans up the draft", async () => {
    saveDepositDraft(WALLET, {
      amount: "100",
      vaultContractId: "CVAULT",
      vaultTokenSymbol: "yVault",
      inputTokenContract: "CXLM",
      inputTokenSymbol: "XLM",
      txHash: "deadbeef",
      submittedAt: Date.now(),
    });
    mockStatusFetch("confirmed", { amount: 100, shares: 98.5 });

    render(<ZapDepositPanel walletAddress={WALLET} />);

    const banner = await screen.findByTestId("deposit-draft-confirmed");
    expect(banner).toHaveTextContent(/100 XLM/);
    expect(banner).toHaveTextContent(/98.5 shares minted/);
    await waitFor(() => expect(loadDepositDraft(WALLET)).toBeNull());
  });

  it("reload long after an unconfirmed submission — shows stale state and cleans up the draft", async () => {
    saveDepositDraft(WALLET, {
      amount: "100",
      vaultContractId: "CVAULT",
      vaultTokenSymbol: "yVault",
      inputTokenContract: "CXLM",
      inputTokenSymbol: "XLM",
      txHash: "deadbeef",
      submittedAt: Date.now() - (DEPOSIT_DRAFT_STALE_MS + 1),
    });
    mockStatusFetch("pending");

    render(<ZapDepositPanel walletAddress={WALLET} />);

    await screen.findByTestId("deposit-draft-stale");
    await waitFor(() => expect(loadDepositDraft(WALLET)).toBeNull());
  });
});
