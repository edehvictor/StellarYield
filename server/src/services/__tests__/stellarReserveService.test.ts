/**
 * Stellar minimum-balance reserve calculation tests (#1148).
 */
import {
  STELLAR_BASE_RESERVE_XLM,
  calculateMinimumReserveXlm,
  evaluateZapReserveSafety,
  getReserveSafetyBufferXlm,
  fetchWalletReserveSnapshot,
} from "../stellarReserveService";

describe("calculateMinimumReserveXlm", () => {
  it("returns (2 + subentries) * baseReserve for a plain account with no subentries", () => {
    expect(calculateMinimumReserveXlm(0)).toBeCloseTo(2 * STELLAR_BASE_RESERVE_XLM, 10);
  });

  it("adds each existing subentry (trustlines, offers, signers, data entries)", () => {
    expect(calculateMinimumReserveXlm(3)).toBeCloseTo(5 * STELLAR_BASE_RESERVE_XLM, 10);
  });

  it("adds additional subentries on top of the current count (e.g. a new trustline)", () => {
    expect(calculateMinimumReserveXlm(1, 1)).toBeCloseTo(4 * STELLAR_BASE_RESERVE_XLM, 10);
  });

  it("clamps negative inputs to zero rather than reducing the reserve below the account floor", () => {
    expect(calculateMinimumReserveXlm(-5)).toBeCloseTo(2 * STELLAR_BASE_RESERVE_XLM, 10);
  });
});

describe("getReserveSafetyBufferXlm", () => {
  const originalEnv = process.env.ZAP_RESERVE_SAFETY_BUFFER_XLM;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ZAP_RESERVE_SAFETY_BUFFER_XLM;
    else process.env.ZAP_RESERVE_SAFETY_BUFFER_XLM = originalEnv;
  });

  it("defaults to one base reserve when unset", () => {
    delete process.env.ZAP_RESERVE_SAFETY_BUFFER_XLM;
    expect(getReserveSafetyBufferXlm()).toBe(STELLAR_BASE_RESERVE_XLM);
  });

  it("honors a configured override", () => {
    process.env.ZAP_RESERVE_SAFETY_BUFFER_XLM = "1.5";
    expect(getReserveSafetyBufferXlm()).toBe(1.5);
  });

  it("falls back to the default for an invalid override", () => {
    process.env.ZAP_RESERVE_SAFETY_BUFFER_XLM = "not-a-number";
    expect(getReserveSafetyBufferXlm()).toBe(STELLAR_BASE_RESERVE_XLM);
  });
});

describe("evaluateZapReserveSafety", () => {
  it("allows a zap that leaves the wallet comfortably above its reserve", () => {
    const result = evaluateZapReserveSafety({
      xlmBalance: 100,
      subentryCount: 1,
      needsNewVaultTrustline: false,
      estimatedNetworkFeeXlm: 0.00001,
      xlmLeavingAccount: 10,
    });

    expect(result.safe).toBe(true);
    expect(result.blockReason).toBeUndefined();
    // required = (2 + 1) * 0.5 + 0.5 buffer = 2.0
    expect(result.requiredReserveXlm).toBeCloseTo(2.0, 10);
    expect(result.projectedBalanceXlm).toBeCloseTo(100 - 0.00001 - 10, 5);
  });

  it("blocks a zap that would fall below the reserve after network fees alone", () => {
    const result = evaluateZapReserveSafety({
      xlmBalance: 1.4,
      subentryCount: 0,
      needsNewVaultTrustline: false,
      estimatedNetworkFeeXlm: 0.001,
      xlmLeavingAccount: 0,
    });

    // required = (2 + 0) * 0.5 + 0.5 = 1.5; projected ~= 1.399
    expect(result.safe).toBe(false);
    expect(result.blockReason).toBe("INSUFFICIENT_RESERVE_AFTER_FEES");
    expect(result.message).toMatch(/minimum balance/i);
  });

  it("allows a zap requiring a new trustline when the balance comfortably clears the higher reserve", () => {
    // required with new trustline = (2+1)*0.5 + 0.5 = 2.0
    const result = evaluateZapReserveSafety({
      xlmBalance: 2.3,
      subentryCount: 0,
      needsNewVaultTrustline: true,
      estimatedNetworkFeeXlm: 0.00001,
      xlmLeavingAccount: 0,
    });

    expect(result.safe).toBe(true);
  });

  it("attributes the block specifically to the new trustline when that's what tips it over", () => {
    const result = evaluateZapReserveSafety({
      xlmBalance: 1.9,
      subentryCount: 0,
      needsNewVaultTrustline: true,
      estimatedNetworkFeeXlm: 0.00001,
      xlmLeavingAccount: 0,
    });

    // required without new trustline = 1.5 (1.9 - ~0 clears this)
    // required with new trustline    = 2.0 (1.9 - ~0 does NOT clear this)
    expect(result.safe).toBe(false);
    expect(result.blockReason).toBe("INSUFFICIENT_RESERVE_AFTER_TRUSTLINE");
    expect(result.message).toMatch(/trustline/i);
  });

  it("blocks a zap that would fall below reserve after the deposited XLM leaves the account", () => {
    const result = evaluateZapReserveSafety({
      xlmBalance: 10,
      subentryCount: 0,
      needsNewVaultTrustline: false,
      estimatedNetworkFeeXlm: 0.00001,
      xlmLeavingAccount: 9,
    });

    // required = 1.5; projected = 10 - 0.00001 - 9 = ~0.99999
    expect(result.safe).toBe(false);
    expect(result.blockReason).toBe("INSUFFICIENT_RESERVE_AFTER_DEPOSIT");
  });

  it("treats a zap that lands exactly on the required reserve as safe (boundary inclusive)", () => {
    const requiredReserveXlm = calculateMinimumReserveXlm(0) + getReserveSafetyBufferXlm();
    const result = evaluateZapReserveSafety({
      xlmBalance: requiredReserveXlm + 5,
      subentryCount: 0,
      needsNewVaultTrustline: false,
      estimatedNetworkFeeXlm: 0,
      xlmLeavingAccount: 5,
    });

    expect(result.safe).toBe(true);
    expect(result.projectedBalanceXlm).toBeCloseTo(requiredReserveXlm, 10);
  });

  it("existing valid zap flows with no wallet balance concerns remain unaffected (regression)", () => {
    // A well-funded wallet depositing a non-native asset (no XLM leaving
    // the account) with an existing trustline should always be safe.
    const result = evaluateZapReserveSafety({
      xlmBalance: 1000,
      subentryCount: 5,
      needsNewVaultTrustline: false,
      estimatedNetworkFeeXlm: 0.0001,
      xlmLeavingAccount: 0,
    });
    expect(result.safe).toBe(true);
  });
});

describe("fetchWalletReserveSnapshot", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns a snapshot with the native balance, subentry count, and trustline status", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subentry_count: 2,
        balances: [
          { asset_type: "native", balance: "42.5000000" },
          { asset_type: "credit_alphanum4", asset_issuer: "CVAULT", balance: "10.0000000" },
        ],
      }),
    }) as unknown as typeof fetch;

    const snapshot = await fetchWalletReserveSnapshot("GADDRESS", "CVAULT");

    expect(snapshot).toEqual({
      xlmBalance: 42.5,
      subentryCount: 2,
      needsNewVaultTrustline: false,
    });
  });

  it("reports needsNewVaultTrustline when no matching balance line exists", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: "5.0000000" }],
      }),
    }) as unknown as typeof fetch;

    const snapshot = await fetchWalletReserveSnapshot("GADDRESS", "CVAULT");
    expect(snapshot?.needsNewVaultTrustline).toBe(true);
  });

  it("returns null when the account can't be loaded (e.g. unfunded, 404)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    const snapshot = await fetchWalletReserveSnapshot("GADDRESS", "CVAULT");
    expect(snapshot).toBeNull();
  });

  it("returns null on a network error rather than throwing", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const snapshot = await fetchWalletReserveSnapshot("GADDRESS", "CVAULT");
    expect(snapshot).toBeNull();
  });
});
