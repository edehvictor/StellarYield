import { describe, it, expect } from "vitest";
import {
  PNL_CSV_COLUMNS,
  validatePnLExportRow,
  validatePnLExportDataset,
  generatePnLCSV,
  formatPnLExportRow,
  type PnLExportRow,
} from "../pnlExport";

describe("PnL Export Schema & Column Validation (#1039)", () => {
  it("defines the required PnL CSV columns in a stable order", () => {
    expect(PNL_CSV_COLUMNS).toEqual([
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

  it("validates and formats a complete valid row with accurate precision", () => {
    const raw = {
      date: "2026-03-01T12:00:00.000Z",
      action: "deposit",
      asset: "usdc",
      amount: 100.123456789,
      costBasisUsd: 100.123,
      realizedGainUsd: 0,
      unrealizedValueUsd: 105.456,
      rewardsUsd: 2.5,
      feesUsd: 0.15,
      txHash: "0xabc123",
    };

    const res = validatePnLExportRow(raw, 0);
    expect(res.isValid).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data?.action).toBe("DEPOSIT");
    expect(res.data?.asset).toBe("USDC");
    expect(res.data?.amount).toBe(100.1234568); // 7 decimal places
    expect(res.data?.costBasisUsd).toBe(100.12);
    expect(res.data?.unrealizedValueUsd).toBe(105.46);
    expect(res.data?.rewardsUsd).toBe(2.5);
    expect(res.data?.feesUsd).toBe(0.15);
  });

  it("rejects incomplete or invalid rows before download", () => {
    // Missing date
    const noDate = {
      action: "DEPOSIT",
      asset: "USDC",
      amount: 100,
      costBasisUsd: 100,
      txHash: "0x123",
    };
    expect(validatePnLExportRow(noDate, 0).isValid).toBe(false);

    // Invalid amount (NaN)
    const nanAmount = {
      date: "2026-03-01T12:00:00Z",
      action: "DEPOSIT",
      asset: "USDC",
      amount: NaN,
      txHash: "0x123",
    };
    expect(validatePnLExportRow(nanAmount, 1).isValid).toBe(false);

    // Negative rewards/fees or invalid action
    const invalidAction = {
      date: "2026-03-01T12:00:00Z",
      action: "",
      asset: "USDC",
      amount: 50,
      txHash: "0x123",
    };
    expect(validatePnLExportRow(invalidAction, 2).isValid).toBe(false);
  });

  it("validates multi-asset dataset and orders rows chronologically", () => {
    const rawDataset = [
      {
        date: "2026-03-10T12:00:00Z",
        action: "HARVEST",
        asset: "XLM",
        amount: 250.5,
        costBasisUsd: 0,
        realizedGainUsd: 35.5,
        unrealizedValueUsd: 0,
        rewardsUsd: 35.5,
        feesUsd: 0.05,
        txHash: "0xsecond",
      },
      {
        date: "2026-03-01T10:00:00Z",
        action: "DEPOSIT",
        asset: "USDC",
        amount: 500,
        costBasisUsd: 500,
        realizedGainUsd: 0,
        unrealizedValueUsd: 500,
        rewardsUsd: 0,
        feesUsd: 0,
        txHash: "0xfirst",
      },
      {
        date: "2026-03-15T15:30:00Z",
        action: "WITHDRAW",
        asset: "USDC",
        amount: 200,
        costBasisUsd: 200,
        realizedGainUsd: 15.2,
        unrealizedValueUsd: 315.2,
        rewardsUsd: 0,
        feesUsd: 0.5,
        txHash: "0xthird",
      },
    ];

    const validation = validatePnLExportDataset(rawDataset);
    expect(validation.isValid).toBe(true);
    expect(validation.data).toHaveLength(3);

    // Assert chronological ordering
    expect(validation.data![0].txHash).toBe("0xfirst");
    expect(validation.data![1].txHash).toBe("0xsecond");
    expect(validation.data![2].txHash).toBe("0xthird");

    // Multi-asset representation preserved
    expect(validation.data![0].asset).toBe("USDC");
    expect(validation.data![1].asset).toBe("XLM");
  });

  it("handles empty export dataset cleanly without error", () => {
    const validation = validatePnLExportDataset([]);
    expect(validation.isValid).toBe(true);
    expect(validation.data).toEqual([]);

    const csv = generatePnLCSV([]);
    expect(csv).toBe(PNL_CSV_COLUMNS.join(","));
  });

  it("generates CSV string with properly escaped special characters and stable columns", () => {
    const row: PnLExportRow = {
      date: "2026-03-01T12:00:00.000Z",
      action: "DEPOSIT",
      asset: "USDC,TEST",
      amount: 100,
      costBasisUsd: 100,
      realizedGainUsd: 0,
      unrealizedValueUsd: 100,
      rewardsUsd: 0,
      feesUsd: 0,
      txHash: '0x"hash"',
    };

    const formattedRow = formatPnLExportRow(row);
    expect(formattedRow).toContain('"USDC,TEST"');
    expect(formattedRow).toContain('"0x""hash"""');

    const fullCsv = generatePnLCSV([row]);
    const lines = fullCsv.split("\n");
    expect(lines[0]).toBe(PNL_CSV_COLUMNS.join(","));
    expect(lines[1]).toBe(formattedRow);
  });
});
