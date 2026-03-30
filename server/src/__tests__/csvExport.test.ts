import {
  generateCSV,
  createCSVStream,
  createExportFilename,
  type TransactionRecord,
} from "../services/export";

// ── generateCSV ─────────────────────────────────────────────────────────

describe("generateCSV", () => {
  it("returns headers only for empty records", () => {
    const csv = generateCSV([]);
    expect(csv).toBe("Date,Action,Asset,Amount,USD Value,TxHash");
  });

  it("generates correct CSV for a single record", () => {
    const records: TransactionRecord[] = [
      {
        date: "2025-01-15T00:00:00.000Z",
        action: "DEPOSIT",
        asset: "USDC",
        amount: 1000,
        usdValue: 1000,
        txHash: "abc123",
      },
    ];
    const csv = generateCSV(records);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Date,Action,Asset,Amount,USD Value,TxHash");
    expect(lines[1]).toContain("2025-01-15T00:00:00.000Z");
    expect(lines[1]).toContain("DEPOSIT");
    expect(lines[1]).toContain("1000.0000000");
    expect(lines[1]).toContain("1000.00");
    expect(lines[1]).toContain("abc123");
  });

  it("generates correct CSV for multiple records", () => {
    const records: TransactionRecord[] = [
      {
        date: "2025-01-15T00:00:00.000Z",
        action: "DEPOSIT",
        asset: "USDC",
        amount: 1000,
        usdValue: 1000,
        txHash: "tx1",
      },
      {
        date: "2025-02-15T00:00:00.000Z",
        action: "WITHDRAW",
        asset: "USDC",
        amount: 500,
        usdValue: 550,
        txHash: "tx2",
      },
      {
        date: "2025-03-01T00:00:00.000Z",
        action: "HARVEST",
        asset: "USDC",
        amount: 25,
        usdValue: 25,
        txHash: "tx3",
      },
    ];
    const csv = generateCSV(records);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(4); // header + 3 rows
  });

  it("escapes fields containing commas", () => {
    const records: TransactionRecord[] = [
      {
        date: "2025-01-01",
        action: "DEPOSIT",
        asset: "USDC,XLMUSDC",
        amount: 1000,
        usdValue: 1000,
        txHash: "tx1",
      },
    ];
    const csv = generateCSV(records);
    expect(csv).toContain('"USDC,XLMUSDC"');
  });

  it("escapes fields containing double quotes", () => {
    const records: TransactionRecord[] = [
      {
        date: "2025-01-01",
        action: 'DEPOSIT "LARGE"',
        asset: "USDC",
        amount: 1000,
        usdValue: 1000,
        txHash: "tx1",
      },
    ];
    const csv = generateCSV(records);
    expect(csv).toContain('"DEPOSIT ""LARGE"""');
  });

  it("formats amount to 7 decimal places", () => {
    const records: TransactionRecord[] = [
      {
        date: "2025-01-01",
        action: "DEPOSIT",
        asset: "USDC",
        amount: 123.456789,
        usdValue: 123.46,
        txHash: "tx1",
      },
    ];
    const csv = generateCSV(records);
    expect(csv).toContain("123.4567890");
  });

  it("formats USD value to 2 decimal places", () => {
    const records: TransactionRecord[] = [
      {
        date: "2025-01-01",
        action: "DEPOSIT",
        asset: "USDC",
        amount: 1000,
        usdValue: 999.999,
        txHash: "tx1",
      },
    ];
    const csv = generateCSV(records);
    expect(csv).toContain("1000.00");
  });
});

// ── createCSVStream ─────────────────────────────────────────────────────

describe("createCSVStream", () => {
  it("streams CSV headers first", async () => {
    const stream = createCSVStream([]);
    const chunks: string[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk.toString());
    }

    expect(chunks[0]).toContain("Date,Action,Asset,Amount,USD Value,TxHash");
  });

  it("streams all records", async () => {
    const records: TransactionRecord[] = Array.from({ length: 250 }, (_, i) => ({
      date: `2025-01-${(i % 28 + 1).toString().padStart(2, "0")}`,
      action: i % 2 === 0 ? "DEPOSIT" : "WITHDRAW",
      asset: "USDC",
      amount: (i + 1) * 100,
      usdValue: (i + 1) * 100,
      txHash: `tx${i}`,
    }));

    const stream = createCSVStream(records);
    let fullContent = "";

    for await (const chunk of stream) {
      fullContent += chunk.toString();
    }

    const lines = fullContent.trim().split("\n");
    // header + 250 data rows
    expect(lines).toHaveLength(251);
  });

  it("handles empty records (header only)", async () => {
    const stream = createCSVStream([]);
    let content = "";

    for await (const chunk of stream) {
      content += chunk.toString();
    }

    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Date");
  });

  it("handles very large dataset (5000 records)", async () => {
    const records: TransactionRecord[] = Array.from(
      { length: 5000 },
      (_, i) => ({
        date: "2025-01-01",
        action: "DEPOSIT",
        asset: "USDC",
        amount: i + 1,
        usdValue: i + 1,
        txHash: `tx${i}`,
      }),
    );

    const stream = createCSVStream(records);
    let lineCount = 0;

    for await (const chunk of stream) {
      const lines = chunk.toString().split("\n").filter(Boolean);
      lineCount += lines.length;
    }

    expect(lineCount).toBe(5001); // header + 5000 rows
  });
});

// ── createExportFilename ────────────────────────────────────────────────

describe("createExportFilename", () => {
  it("includes address prefix", () => {
    const filename = createExportFilename("GABCDEFGHIJKLMN");
    expect(filename).toContain("GABCDEFG");
  });

  it("includes date", () => {
    const filename = createExportFilename("GABCDEF");
    const today = new Date().toISOString().split("T")[0];
    expect(filename).toContain(today);
  });

  it("has .csv extension", () => {
    const filename = createExportFilename("GABCDEF");
    expect(filename).toMatch(/\.csv$/);
  });

  it("starts with stellaryield prefix", () => {
    const filename = createExportFilename("GABCDEF");
    expect(filename).toMatch(/^stellaryield-tax-report-/);
  });
});
