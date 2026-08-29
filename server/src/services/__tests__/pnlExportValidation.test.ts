import {
  PNL_EXPORT_COLUMNS,
  validatePnLExportRecord,
  validatePnLExportDataset,
  generatePnLCSV,
} from "../pnlCalculator";

describe("Server PnL Export Column & Format Validation (#1039)", () => {
  it("includes all required columns in correct sequence", () => {
    expect(PNL_EXPORT_COLUMNS).toEqual([
      "Date",
      "Action",
      "Asset",
      "Amount",
      "Cost Basis USD",
      "Realized Gain USD",
      "Unrealized Value USD",
      "Rewards USD",
      "Fees USD",
      "TxHash",
    ]);
  });

  it("validates valid record and formats precision cleanly", () => {
    const raw = {
      date: "2026-03-01T10:00:00.000Z",
      action: "deposit",
      asset: "usdc",
      amount: 100.5,
      costBasisUsd: 100.5,
      realizedGainUsd: 0,
      unrealizedValueUsd: 100.5,
      rewardsUsd: 0,
      feesUsd: 0,
      txHash: "0x12345",
    };

    const res = validatePnLExportRecord(raw, 0);
    expect(res.isValid).toBe(true);
    expect(res.record?.amount).toBe(100.5);
    expect(res.record?.action).toBe("DEPOSIT");
    expect(res.record?.asset).toBe("USDC");
  });

  it("rejects invalid rows with clear error reasons", () => {
    const missingDate = {
      action: "DEPOSIT",
      amount: 100,
      txHash: "0x123",
    };
    expect(validatePnLExportRecord(missingDate, 0).isValid).toBe(false);

    const invalidAmount = {
      date: "2026-03-01T10:00:00Z",
      action: "DEPOSIT",
      amount: -5,
      txHash: "0x123",
    };
    expect(validatePnLExportRecord(invalidAmount, 1).isValid).toBe(false);
  });

  it("sorts dataset chronologically and generates formatted CSV", () => {
    const rows = [
      {
        date: "2026-03-05T00:00:00Z",
        action: "HARVEST",
        asset: "XLM",
        amount: 50,
        costBasisUsd: 0,
        realizedGainUsd: 10,
        unrealizedValueUsd: 0,
        rewardsUsd: 10,
        feesUsd: 0,
        txHash: "0x2",
      },
      {
        date: "2026-03-01T00:00:00Z",
        action: "DEPOSIT",
        asset: "USDC",
        amount: 1000,
        costBasisUsd: 1000,
        realizedGainUsd: 0,
        unrealizedValueUsd: 1000,
        rewardsUsd: 0,
        feesUsd: 0,
        txHash: "0x1",
      },
    ];

    const csv = generatePnLCSV(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(PNL_EXPORT_COLUMNS.join(","));
    expect(lines[1]).toContain("0x1");
    expect(lines[2]).toContain("0x2");
  });
});
