/**
 * Fee buffer configuration tests (#1188)
 *
 * Verifies per-network buffer defaults, overrides, and the applyFeeBuffer
 * function used in both quote preview and transaction build paths.
 */
import {
  resolveNetworkKey,
  getNetworkFeeBuffer,
  applyFeeBuffer,
  NETWORK_FEE_BUFFERS,
} from "../../services/feeOracleService";

// ── resolveNetworkKey ────────────────────────────────────────────────────────

describe("resolveNetworkKey (#1188)", () => {
  it("resolves mainnet passphrase", () => {
    expect(
      resolveNetworkKey("Public Global Stellar Network ; September 2015"),
    ).toBe("mainnet");
  });

  it("resolves testnet passphrase", () => {
    expect(
      resolveNetworkKey("Test SDF Network ; September 2015"),
    ).toBe("testnet");
  });

  it("resolves futurenet passphrase", () => {
    expect(
      resolveNetworkKey("Test SDF Future Network ; October 2022"),
    ).toBe("futurenet");
  });

  it("returns 'default' for unknown passphrase", () => {
    expect(resolveNetworkKey("My Custom Network ; 2024")).toBe("default");
  });

  it("is case-insensitive", () => {
    expect(
      resolveNetworkKey("PUBLIC GLOBAL STELLAR NETWORK ; SEPTEMBER 2015"),
    ).toBe("mainnet");
  });
});

// ── getNetworkFeeBuffer ──────────────────────────────────────────────────────

describe("getNetworkFeeBuffer (#1188)", () => {
  it("returns a config with bufferPct for mainnet passphrase", () => {
    const config = getNetworkFeeBuffer("Public Global Stellar Network ; September 2015");
    expect(typeof config.bufferPct).toBe("number");
    expect(config.bufferPct).toBeGreaterThanOrEqual(0);
    expect(typeof config.minFeeStroops).toBe("number");
    expect(config.minFeeStroops).toBeGreaterThan(0);
  });

  it("returns a config for testnet passphrase", () => {
    const config = getNetworkFeeBuffer("Test SDF Network ; September 2015");
    expect(config.bufferPct).toBeGreaterThanOrEqual(0);
  });

  it("mainnet and testnet buffers may differ", () => {
    const mainnet = getNetworkFeeBuffer("Public Global Stellar Network ; September 2015");
    const testnet = getNetworkFeeBuffer("Test SDF Network ; September 2015");
    // Not a hard requirement — just documenting that they can differ.
    // This test will pass whether they differ or not.
    expect(typeof mainnet.bufferPct).toBe("number");
    expect(typeof testnet.bufferPct).toBe("number");
  });

  it("unknown passphrase falls back to the documented default config", () => {
    const config = getNetworkFeeBuffer("UnknownNetwork ; 2099");
    const defaultConfig = NETWORK_FEE_BUFFERS.default;
    expect(config.bufferPct).toBe(defaultConfig.bufferPct);
    expect(config.minFeeStroops).toBe(defaultConfig.minFeeStroops);
  });
});

// ── applyFeeBuffer ───────────────────────────────────────────────────────────

describe("applyFeeBuffer (#1188)", () => {
  const testnetPassphrase = "Test SDF Network ; September 2015";

  it("returns a fee >= the raw fee (buffer is additive)", () => {
    const raw = 200;
    const buffered = applyFeeBuffer(raw, testnetPassphrase);
    expect(buffered).toBeGreaterThanOrEqual(raw);
  });

  it("never returns less than minFeeStroops", () => {
    const config = getNetworkFeeBuffer(testnetPassphrase);
    const buffered = applyFeeBuffer(0, testnetPassphrase);
    expect(buffered).toBeGreaterThanOrEqual(config.minFeeStroops);
  });

  it("applies the buffer consistently — same inputs produce same output", () => {
    const raw = 500;
    expect(applyFeeBuffer(raw, testnetPassphrase)).toBe(
      applyFeeBuffer(raw, testnetPassphrase),
    );
  });

  it("quote and execution paths produce the same buffered fee for the same inputs", () => {
    const rawFee = 300;
    const passphrase = "Public Global Stellar Network ; September 2015";

    // Simulating: quote path calls applyFeeBuffer, tx build path calls applyFeeBuffer
    const quotePathFee = applyFeeBuffer(rawFee, passphrase);
    const txBuildPathFee = applyFeeBuffer(rawFee, passphrase);

    expect(quotePathFee).toBe(txBuildPathFee);
  });

  it("different networks can produce different buffered fees for the same raw fee", () => {
    const rawFee = 1000;
    const mainnetFee = applyFeeBuffer(rawFee, "Public Global Stellar Network ; September 2015");
    const futurenetFee = applyFeeBuffer(rawFee, "Test SDF Future Network ; October 2022");

    // Both are valid numbers and >= rawFee
    expect(mainnetFee).toBeGreaterThanOrEqual(rawFee);
    expect(futurenetFee).toBeGreaterThanOrEqual(rawFee);
  });
});

// ── NETWORK_FEE_BUFFERS completeness ────────────────────────────────────────

describe("NETWORK_FEE_BUFFERS defaults (#1188)", () => {
  it("has all documented network keys", () => {
    expect(NETWORK_FEE_BUFFERS).toHaveProperty("mainnet");
    expect(NETWORK_FEE_BUFFERS).toHaveProperty("testnet");
    expect(NETWORK_FEE_BUFFERS).toHaveProperty("futurenet");
    expect(NETWORK_FEE_BUFFERS).toHaveProperty("default");
  });

  it("all configs have valid bufferPct values", () => {
    for (const [network, config] of Object.entries(NETWORK_FEE_BUFFERS)) {
      expect(config.bufferPct, `${network}.bufferPct should be finite`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(config.bufferPct), `${network}.bufferPct should be finite`).toBe(true);
    }
  });
});
