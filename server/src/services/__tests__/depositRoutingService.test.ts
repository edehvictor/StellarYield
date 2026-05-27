import { recommendDepositRouting } from "../depositRoutingService";
import { getZapSupportedAssetsPayload } from "../../config/zapAssetsConfig";
import { getZapQuote } from "../zapQuote";
import { getFeeOracleEstimate } from "../feeOracleService";

jest.mock("../../config/zapAssetsConfig");
jest.mock("../zapQuote");
jest.mock("../feeOracleService");

const mockGetPayload = getZapSupportedAssetsPayload as jest.MockedFunction<
  typeof getZapSupportedAssetsPayload
>;
const mockGetZapQuote = getZapQuote as jest.MockedFunction<typeof getZapQuote>;
const mockGetFee = getFeeOracleEstimate as jest.MockedFunction<
  typeof getFeeOracleEstimate
>;

const XLM = { symbol: "XLM", name: "Stellar Lumens", contractId: "C_XLM", decimals: 7 };
const USDC = { symbol: "USDC", name: "USD Coin", contractId: "C_USDC", decimals: 7 };
const AQUA = { symbol: "AQUA", name: "Aquarius", contractId: "C_AQUA", decimals: 7 };

beforeEach(() => {
  jest.clearAllMocks();

  mockGetPayload.mockReturnValue({
    assets: [XLM, USDC, AQUA],
    vaultToken: USDC,
    vaultContractId: "C_USDC",
  });

  mockGetZapQuote.mockResolvedValue({
    path: [
      { contractId: "C_XLM", label: "XLM" },
      { contractId: "C_USDC", label: "USDC" },
    ],
    expectedAmountOutStroops: "1000",
    source: "router_simulation",
    slippageApplied: 0.005,
    amountOutAfterSlippage: "995",
    quotedAt: "2026-01-01T00:00:00.000Z",
    minAmountOutStroops: "995",
    quoteAgeMs: 0,
    isFallback: false,
  });

  mockGetFee.mockResolvedValue({
    networkPassphrase: "Test",
    sampleSize: 20,
    utilization: { averageTxSetSize: 1, maxTxSetSize: 2, congestionRatio: 0.1 },
    fees: { low: 100, average: 200, high: 400 },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("recommendDepositRouting", () => {
  it("routes a mixed basket: converts non-vault assets, deposits vault token directly", async () => {
    const result = await recommendDepositRouting([
      { symbol: "XLM", amountInStroops: "1000000" },
      { symbol: "USDC", amountInStroops: "5000" },
    ]);

    expect(result.routes).toHaveLength(2);
    expect(result.unsupportedAssets).toHaveLength(0);

    const xlm = result.routes.find((r) => r.symbol === "XLM")!;
    expect(xlm.action).toBe("convert");
    expect(xlm.expectedVaultAmountStroops).toBe("995");
    expect(xlm.path).toHaveLength(2);

    const usdc = result.routes.find((r) => r.symbol === "USDC")!;
    expect(usdc.action).toBe("direct");
    expect(usdc.expectedVaultAmountStroops).toBe("5000");
    expect(usdc.slippageApplied).toBe(0);

    // only the XLM leg required a conversion quote
    expect(mockGetZapQuote).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported assets instead of routing them", async () => {
    const result = await recommendDepositRouting([
      { symbol: "DOGE", amountInStroops: "1000" },
      { symbol: "XLM", amountInStroops: "2000" },
    ]);

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].symbol).toBe("XLM");
    expect(result.unsupportedAssets).toHaveLength(1);
    expect(result.unsupportedAssets[0].symbol).toBe("DOGE");
    expect(result.unsupportedAssets[0].reason).toMatch(/not in the supported-asset registry/i);
  });

  it("matches symbols case-insensitively", async () => {
    const result = await recommendDepositRouting([
      { symbol: "xlm", amountInStroops: "1000" },
    ]);
    expect(result.unsupportedAssets).toHaveLength(0);
    expect(result.routes[0].symbol).toBe("XLM");
  });

  it("sums expected vault output and estimates fee per conversion", async () => {
    const result = await recommendDepositRouting([
      { symbol: "XLM", amountInStroops: "1000000" }, // -> 995
      { symbol: "AQUA", amountInStroops: "2000000" }, // -> 995
      { symbol: "USDC", amountInStroops: "5000" }, // direct -> 5000
    ]);

    // 995 + 995 + 5000
    expect(result.totals.expectedVaultAmountStroops).toBe("6990");
    expect(result.totals.routableAssets).toBe(3);
    // 2 conversions × average fee 200
    expect(result.totals.estimatedNetworkFeeStroops).toBe("400");
  });

  it("charges no network fee and skips the fee oracle when nothing converts", async () => {
    const result = await recommendDepositRouting([
      { symbol: "USDC", amountInStroops: "5000" },
    ]);

    expect(result.totals.estimatedNetworkFeeStroops).toBe("0");
    expect(mockGetFee).not.toHaveBeenCalled();
    expect(mockGetZapQuote).not.toHaveBeenCalled();
  });

  it("degrades gracefully with a warning when the fee oracle is unavailable", async () => {
    mockGetFee.mockRejectedValueOnce(new Error("oracle down"));

    const result = await recommendDepositRouting([
      { symbol: "XLM", amountInStroops: "1000000" },
    ]);

    expect(result.totals.expectedVaultAmountStroops).toBe("995");
    expect(result.totals.estimatedNetworkFeeStroops).toBe("0");
    expect(result.warnings.some((w) => /fee estimate unavailable/i.test(w))).toBe(true);
  });

  it("warns when no supported assets are present", async () => {
    const result = await recommendDepositRouting([
      { symbol: "DOGE", amountInStroops: "1000" },
    ]);

    expect(result.routes).toHaveLength(0);
    expect(result.unsupportedAssets).toHaveLength(1);
    expect(result.warnings.some((w) => /nothing to route/i.test(w))).toBe(true);
  });

  it("reports the vault token metadata in the result", async () => {
    const result = await recommendDepositRouting([
      { symbol: "USDC", amountInStroops: "1000" },
    ]);
    expect(result.vaultToken).toEqual({
      symbol: "USDC",
      contractId: "C_USDC",
      decimals: 7,
    });
  });
});
