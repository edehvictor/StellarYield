import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ZapDepositPanel from "./ZapDepositPanel";

/**
 * Issue #1891 — transaction review partial completion and retry.
 *
 * A deposit can be interrupted after the wallet signs: the send can drop or
 * confirmation polling can time out while the transaction still lands. The
 * retry that follows must not submit a second deposit until the ledger
 * settles the first, and must allow one as soon as nothing can move.
 */

const HASH = "f".repeat(64);
const WALLET = "GREVIEWRETRY";

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("./assets", () => ({
  shouldLoadZapMetadataFromApi: () => false,
  getVaultTokenFromEnv: () => ({ symbol: "yVault", name: "Yield Vault", contractId: "CVAULT", decimals: 7 }),
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

type Hooks = { onSigned?: (hash: string) => void; onSubmitted?: (hash: string) => void };
type OnPhase = (phase: string) => void;

const mockZapDeposit = vi.fn();
const mockLedger = vi.fn();
vi.mock("../../services/soroban", () => ({
  zapDeposit: (...args: unknown[]) => mockZapDeposit(...args),
  getLedgerTransactionStatus: (hash: string) => mockLedger(hash),
}));

vi.mock("../settings/SettingsContext", () => ({ useSettings: () => ({ settings: {} }) }));
vi.mock("../settings/types", () => ({ resolveSlippage: () => 0.5 }));
vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({
    isConnected: true,
    isSessionExpired: false,
    connectWallet: vi.fn().mockResolvedValue(true),
    providerId: "freighter",
  }),
}));

function quote() {
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
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    minAmountOutStroops: "9452500",
    quoteAgeMs: 100,
    isFallback: false,
    routeHash: "route-1",
  };
}

const journalCalls: Array<{ url: string; body: unknown }> = [];
let journalBeginStatus = 201;

function mockRoutes() {
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/zap/review-operations")) {
      journalCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (!url.includes("/events") && journalBeginStatus === 409) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            error: "REVIEW_OPERATION_IN_FLIGHT",
            message: "Another deposit from this wallet is signed and may still land.",
            details: { operation: { txHash: HASH } },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    if (url.includes("/api/zap/verify")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    }
    if (url.includes("/api/deposits/status")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ txHash: HASH, status: "pending" }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => quote() });
  });
}

/** zapDeposit stand-in: signs (reporting the hash), then returns `result`. */
function signThenReturn(result: Record<string, unknown>) {
  return async (_wallet: string, _params: unknown, onPhase: OnPhase, _bump: boolean, _settings: unknown, hooks: Hooks) => {
    hooks?.onSigned?.(HASH);
    onPhase?.(result.success ? "success" : "failure");
    return result;
  };
}

async function enterAmountAndAwaitQuote(amount: string) {
  await userEvent.type(screen.getByPlaceholderText("0.00"), amount);
  await waitFor(() => expect(screen.getByText(/Min\. after/)).toBeInTheDocument());
}

const clickZap = () => fireEvent.click(screen.getByRole("button", { name: /Zap deposit/i }));
const storedDraft = () => JSON.parse(localStorage.getItem(`deposit_draft_${WALLET}`) ?? "null");

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  journalCalls.length = 0;
  journalBeginStatus = 201;
  mockRoutes();
  mockLedger.mockResolvedValue("not_found");
});

describe("ZapDepositPanel review retry (#1891)", () => {
  it("records the signed hash before sending, and does not resubmit a timed-out deposit", async () => {
    mockZapDeposit.mockImplementation(
      signThenReturn({ success: false, hash: HASH, pending: true, error: "Transaction timed out" }),
    );
    render(<ZapDepositPanel walletAddress={WALLET} />);
    await enterAmountAndAwaitQuote("100");

    clickZap();
    await waitFor(() => expect(screen.getByText(/sent but is not confirmed yet/)).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("deposit-draft-pending")).toBeInTheDocument();
    expect(storedDraft()).toMatchObject({ txHash: HASH, operationId: expect.stringMatching(/^zap-/) });
    expect(storedDraft().deadlineUnixSeconds).toBeGreaterThan(Date.now() / 1000);

    const events = journalCalls.filter((c) => c.url.includes("/events")).map((c) => (c.body as { type: string }).type);
    expect(events).toEqual(["signed", "failed"]);

    // The user retries while the ledger has not seen it yet.
    clickZap();
    await waitFor(() => expect(screen.getByText(/previous deposit is still processing/)).toBeInTheDocument());
    expect(mockLedger).toHaveBeenCalledWith(HASH);
    expect(mockZapDeposit).toHaveBeenCalledTimes(1);
  });

  it("treats a dropped send after signing as in flight", async () => {
    mockZapDeposit.mockImplementation(signThenReturn({ success: false, error: "Failed to fetch" }));
    render(<ZapDepositPanel walletAddress={WALLET} />);
    await enterAmountAndAwaitQuote("100");

    clickZap();
    await waitFor(() => expect(screen.getByText(/sent but is not confirmed yet/)).toBeInTheDocument());
    expect(storedDraft().txHash).toBe(HASH);
  });

  it("allows a new deposit once the ledger confirms the earlier one", async () => {
    mockZapDeposit.mockImplementationOnce(
      signThenReturn({ success: false, hash: HASH, pending: true, error: "Transaction timed out" }),
    );
    render(<ZapDepositPanel walletAddress={WALLET} />);
    await enterAmountAndAwaitQuote("100");
    clickZap();
    await waitFor(() => expect(screen.getByText(/sent but is not confirmed yet/)).toBeInTheDocument());

    mockLedger.mockResolvedValue("success");
    mockZapDeposit.mockImplementationOnce(signThenReturn({ success: true, hash: HASH }));
    clickZap();

    await waitFor(() => expect(mockZapDeposit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(storedDraft()).toMatchObject({ ledgerConfirmed: true }));
  });

  it("clears the draft after an on-chain failure so the retry submits again", async () => {
    mockZapDeposit.mockImplementationOnce(
      signThenReturn({ success: false, hash: HASH, error: "Transaction failed on-chain" }),
    );
    render(<ZapDepositPanel walletAddress={WALLET} />);
    await enterAmountAndAwaitQuote("100");

    clickZap();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(storedDraft()).toBeNull();
    const failed = journalCalls.find((c) => (c.body as { type?: string } | undefined)?.type === "failed");
    expect(failed?.body).toMatchObject({ code: "TX_FAILED_ONCHAIN" });

    mockZapDeposit.mockImplementationOnce(signThenReturn({ success: true, hash: HASH }));
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    clickZap();
    await waitFor(() => expect(mockZapDeposit).toHaveBeenCalledTimes(2));
    expect(mockLedger).not.toHaveBeenCalled();
  });

  it("does not submit while the server journal reports another deposit in flight", async () => {
    journalBeginStatus = 409;
    mockZapDeposit.mockImplementation(signThenReturn({ success: true, hash: HASH }));
    render(<ZapDepositPanel walletAddress={WALLET} />);
    await enterAmountAndAwaitQuote("100");

    clickZap();
    await waitFor(() => expect(screen.getByText(/Nothing was submitted/)).toBeInTheDocument());
    expect(mockZapDeposit).not.toHaveBeenCalled();
    expect(storedDraft()).toBeNull();
  });

  it("still submits when the journal cannot be reached", async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/zap/review-operations")) return Promise.reject(new TypeError("Failed to fetch"));
      if (url.includes("/api/zap/verify")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => quote() });
    });
    mockZapDeposit.mockImplementation(signThenReturn({ success: true, hash: HASH }));
    render(<ZapDepositPanel walletAddress={WALLET} />);
    await enterAmountAndAwaitQuote("100");

    clickZap();
    await waitFor(() => expect(mockZapDeposit).toHaveBeenCalledTimes(1));
  });
});
