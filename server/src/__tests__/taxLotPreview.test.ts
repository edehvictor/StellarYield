import {
  buildTaxLotPreview,
  previewToCsvRecords,
  type RawTaxTransaction,
} from "../services/export/taxLotPreview";
import { generateCSV } from "../services/export/csvGenerator";

const makeTx = (
  overrides: Partial<RawTaxTransaction> = {},
): RawTaxTransaction => ({
  action: "DEPOSIT",
  amount: 100,
  shares: 100,
  sharePriceAtTx: 1.0,
  txHash: "tx-1",
  timestamp: new Date("2026-01-01T00:00:00Z"),
  asset: "USDC",
  ...overrides,
});

describe("buildTaxLotPreview", () => {
  it("returns an empty preview for no transactions and allows download", () => {
    const preview = buildTaxLotPreview([]);
    expect(preview.rows).toEqual([]);
    expect(preview.warnings).toEqual([]);
    expect(preview.totals.rows).toBe(0);
    expect(preview.canDownload).toBe(true);
  });

  it("computes cost basis for deposits and realized yield for harvests", () => {
    const preview = buildTaxLotPreview([
      makeTx({ action: "DEPOSIT", amount: 100, sharePriceAtTx: 1.0, txHash: "d1" }),
      makeTx({
        action: "HARVEST",
        amount: 5,
        sharePriceAtTx: 1.02,
        txHash: "h1",
        timestamp: new Date("2026-01-15T00:00:00Z"),
      }),
    ]);

    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0].costBasisUsd).toBe(100);
    expect(preview.rows[0].realizedYieldUsd).toBeNull();
    expect(preview.rows[1].costBasisUsd).toBeNull();
    expect(preview.rows[1].realizedYieldUsd).toBeCloseTo(5.1, 5);
    expect(preview.totals.costBasisUsd).toBe(100);
    expect(preview.totals.realizedYieldUsd).toBeCloseTo(5.1, 2);
    expect(preview.canDownload).toBe(true);
  });

  it("flags missing basis on deposits with non-positive share price", () => {
    const preview = buildTaxLotPreview([
      makeTx({ action: "DEPOSIT", sharePriceAtTx: 0, txHash: "d-broken" }),
    ]);
    expect(preview.rows[0].warnings).toEqual(["MISSING_BASIS"]);
    expect(preview.warnings[0].code).toBe("MISSING_BASIS");
    expect(preview.canDownload).toBe(false);
  });

  it("flags missing timestamps and refuses download", () => {
    const preview = buildTaxLotPreview([
      makeTx({ timestamp: "not-a-date", txHash: "bad-time" }),
    ]);
    expect(preview.rows[0].date).toBeNull();
    expect(preview.rows[0].warnings).toContain("MISSING_TIMESTAMP");
    expect(preview.canDownload).toBe(false);
  });

  it("flags unsupported tokens but still records the row", () => {
    const preview = buildTaxLotPreview([
      makeTx({ asset: "AQUA", txHash: "aqua-1" }),
    ]);
    expect(preview.rows[0].warnings).toContain("UNSUPPORTED_TOKEN");
    expect(preview.canDownload).toBe(false);
  });

  it("honours an explicit supported-token list", () => {
    const preview = buildTaxLotPreview(
      [makeTx({ asset: "XLM", txHash: "xlm-1" })],
      { supportedTokens: ["XLM"] },
    );
    expect(preview.rows[0].warnings).not.toContain("UNSUPPORTED_TOKEN");
    expect(preview.canDownload).toBe(true);
  });

  it("treats harvests without a share price as missing basis", () => {
    const preview = buildTaxLotPreview([
      makeTx({
        action: "HARVEST",
        sharePriceAtTx: 0,
        txHash: "h-broken",
      }),
    ]);
    expect(preview.rows[0].warnings).toContain("MISSING_BASIS");
    expect(preview.canDownload).toBe(false);
  });
});

describe("previewToCsvRecords", () => {
  it("drops rows with missing timestamps so the CSV never has empty dates", () => {
    const preview = buildTaxLotPreview([
      makeTx({ txHash: "ok" }),
      makeTx({ timestamp: undefined, txHash: "missing" }),
    ]);
    const records = previewToCsvRecords(preview);
    expect(records).toHaveLength(1);
    expect(records[0].txHash).toBe("ok");
  });

  it("falls back from cost basis to realized yield in the CSV usdValue column", () => {
    const preview = buildTaxLotPreview([
      makeTx({
        action: "WITHDRAWAL",
        amount: 10,
        sharePriceAtTx: 2.0,
        txHash: "w1",
      }),
    ]);
    const records = previewToCsvRecords(preview);
    expect(records[0].usdValue).toBe(20);
    expect(generateCSV(records).split("\n")[0]).toMatch(/Date,Action,Asset/);
  });
});
