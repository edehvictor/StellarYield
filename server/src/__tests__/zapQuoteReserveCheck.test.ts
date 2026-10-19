/**
 * Zap quote minimum-balance reserve check (#1148).
 *
 * Verifies that supplying `walletAddress` in a zap quote request runs the
 * reserve check and attaches a typed `reserveCheck` verdict to the quote
 * response, and that omitting it leaves the existing quote response shape
 * completely unchanged (regression coverage for pre-#1148 callers).
 */
import { getZapQuote } from "../services/zapQuote";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { getFeeOracleEstimate } from "../services/feeOracleService";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
  ]),
}));

jest.mock("../services/freezeService", () => ({
  freezeService: {
    isFrozen: jest.fn().mockReturnValue(false),
  },
}));

jest.mock("../config/zapAssetsConfig");
jest.mock("../services/feeOracleService");

const mockGetPayload = getZapSupportedAssetsPayload as jest.MockedFunction<
  typeof getZapSupportedAssetsPayload
>;
const mockGetFee = getFeeOracleEstimate as jest.MockedFunction<typeof getFeeOracleEstimate>;

const XLM = { symbol: "XLM", name: "Stellar Lumens", contractId: "C_XLM", decimals: 7 };
const VAULT = { symbol: "yVault", name: "Yield Vault", contractId: "C_VAULT", decimals: 7 };

const originalFetch = global.fetch;

function mockHorizonAccount(overrides: {
  xlmBalance: string;
  subentryCount: number;
  hasVaultTrustline: boolean;
}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      subentry_count: overrides.subentryCount,
      balances: [
        { asset_type: "native", balance: overrides.xlmBalance },
        ...(overrides.hasVaultTrustline
          ? [{ asset_type: "credit_alphanum4", asset_issuer: "C_VAULT", balance: "10" }]
          : []),
      ],
    }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = originalFetch;

  mockGetPayload.mockReturnValue({
    assets: [XLM],
    vaultToken: VAULT,
    vaultContractId: "C_VAULT",
  });

  mockGetFee.mockResolvedValue({
    networkPassphrase: "Test",
    sampleSize: 20,
    utilization: { averageTxSetSize: 1, maxTxSetSize: 2, congestionRatio: 0.1 },
    fees: { low: 100, average: 200, high: 400 },
    bufferedFees: { low: 105, average: 210, high: 420 },
    feeBuffer: { network: "testnet", multiplier: 1.05 } as unknown as never,
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("getZapQuote — reserve check (#1148)", () => {
  it("omits reserveCheck entirely when no walletAddress is supplied (unchanged for existing callers)", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const quote = await getZapQuote({
      inputTokenContract: "C_XLM",
      vaultTokenContract: "C_VAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    expect(quote.reserveCheck).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a zap for a well-funded wallet with an existing trustline", async () => {
    mockHorizonAccount({ xlmBalance: "1000.0000000", subentryCount: 1, hasVaultTrustline: true });

    const quote = await getZapQuote({
      inputTokenContract: "C_XLM",
      vaultTokenContract: "C_VAULT",
      amountInStroops: "10000000", // 1 XLM
      inputDecimals: 7,
      vaultDecimals: 7,
      walletAddress: "GWALLET",
    });

    expect(quote.reserveCheck?.safe).toBe(true);
    expect(quote.reserveCheck?.blockReason).toBeUndefined();
  });

  it("blocks a zap that would drop a thinly-funded wallet below its required reserve", async () => {
    // Balance just above what a 1 XLM deposit + fees + new trustline reserve would allow.
    mockHorizonAccount({ xlmBalance: "1.6000000", subentryCount: 0, hasVaultTrustline: false });

    const quote = await getZapQuote({
      inputTokenContract: "C_XLM",
      vaultTokenContract: "C_VAULT",
      amountInStroops: "10000000", // 1 XLM leaving the account
      inputDecimals: 7,
      vaultDecimals: 7,
      walletAddress: "GWALLET",
    });

    expect(quote.reserveCheck?.safe).toBe(false);
    expect(quote.reserveCheck?.blockReason).toBeDefined();
    expect(quote.reserveCheck?.message).toMatch(/minimum balance/i);
  });

  it("degrades gracefully (no reserveCheck, quote still succeeds) when the wallet snapshot can't be fetched", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const quote = await getZapQuote({
      inputTokenContract: "C_XLM",
      vaultTokenContract: "C_VAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
      walletAddress: "GWALLET",
    });

    expect(quote.reserveCheck).toBeUndefined();
    expect(quote.expectedAmountOutStroops).toBeDefined();
  });

  it("does not treat a non-native asset deposit as XLM leaving the account", async () => {
    // Depositing a non-XLM asset shouldn't reduce the native balance beyond
    // the network fee, even for a thin wallet.
    mockHorizonAccount({ xlmBalance: "3.0000000", subentryCount: 0, hasVaultTrustline: true });

    const quote = await getZapQuote({
      inputTokenContract: "C_OTHER_ASSET",
      vaultTokenContract: "C_VAULT",
      amountInStroops: "50000000000", // large amount of a non-native asset
      inputDecimals: 7,
      vaultDecimals: 7,
      walletAddress: "GWALLET",
    });

    expect(quote.reserveCheck?.safe).toBe(true);
  });

  it("existing zap flows without a walletAddress continue to work unchanged (regression)", async () => {
    const quote = await getZapQuote({
      inputTokenContract: "C_XLM",
      vaultTokenContract: "C_VAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    expect(quote.expectedAmountOutStroops).toBeDefined();
    expect(quote.source).toBeDefined();
    expect("reserveCheck" in quote).toBe(false);
  });
});
