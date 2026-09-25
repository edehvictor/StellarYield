/**
 * Deterministic CSV schema validation — Issue #1306.
 *
 * Normal path: valid records render with the exact header order.
 * Edge cases: invalid rows throw typed CsvValidationError (never NaN
 *              silently formatted); tampered CSV text fails header and
 *              column-count checks deterministically.
 */
import {
  CSV_HEADER_LINE,
  CsvValidationError,
  generateCSV,
  parseCsvLine,
  validateCsvContent,
  validateTransactionDataset,
  validateTransactionRecord,
  type TransactionRecord,
} from "../services/export/csvGenerator";

const validRecord: TransactionRecord = {
  date: "2025-01-15T00:00:00.000Z",
  action: "DEPOSIT",
  asset: "USDC",
  amount: 1000,
  usdValue: 1000,
  txHash: "abc123",
};

describe("csvSchemaValidation (#1306)", () => {
  it("accepts a valid record with no issues", () => {
    expect(validateTransactionRecord(validRecord, 1)).toEqual([]);
  });

  it("uses the exact deterministic header order", () => {
    expect(CSV_HEADER_LINE).toBe(
      "Date,Action,Asset,Amount,USD Value,TxHash",
    );
    expect(generateCSV([])).toBe(CSV_HEADER_LINE);
  });

  it("round-trips valid records through content validation", () => {
    const csv = generateCSV([validRecord]);
    expect(() => validateCsvContent(csv)).not.toThrow();
  });

  it("rejects NaN amounts with a typed INVALID_AMOUNT error", () => {
    const issues = validateTransactionRecord(
      { ...validRecord, amount: NaN },
      2,
    );
    expect(issues.map((i) => i.code)).toContain("INVALID_AMOUNT");
    expect(() => validateTransactionDataset([{ ...validRecord, amount: NaN }])).toThrow(
      CsvValidationError,
    );
  });

  it("rejects negative usdValue, empty action, and bad dates", () => {
    expect(
      validateTransactionRecord({ ...validRecord, usdValue: -1 }, 1).map(
        (i) => i.code,
      ),
    ).toContain("INVALID_USD_VALUE");
    expect(
      validateTransactionRecord({ ...validRecord, action: "  " }, 1).map(
        (i) => i.code,
      ),
    ).toContain("INVALID_ACTION");
    expect(
      validateTransactionRecord({ ...validRecord, date: "not-a-date" }, 1).map(
        (i) => i.code,
      ),
    ).toContain("INVALID_DATE");
    expect(
      validateTransactionRecord({ ...validRecord, txHash: "" }, 1).map(
        (i) => i.code,
      ),
    ).toContain("INVALID_TX_HASH");
  });

  it("generateCSV throws a deterministic typed error listing every bad row", () => {
    let caught: unknown;
    try {
      generateCSV([
        validRecord,
        { ...validRecord, amount: NaN },
        { ...validRecord, txHash: "" },
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CsvValidationError);
    const issues = (caught as CsvValidationError).issues;
    expect(issues.map((i) => i.row)).toEqual([2, 3]);
    expect((caught as Error).message).toMatch(/schema validation failed/);
  });

  it("validateCsvContent rejects a reordered header", () => {
    const bad = generateCSV([validRecord]).replace(
      CSV_HEADER_LINE,
      "Action,Date,Asset,Amount,USD Value,TxHash",
    );
    expect(() => validateCsvContent(bad)).toThrowError(
      expect.objectContaining({ code: "CSV_SCHEMA_VALIDATION_FAILED" }),
    );
  });

  it("validateCsvContent rejects rows with the wrong column count", () => {
    const bad = `${CSV_HEADER_LINE}\n2025-01-01,DEPOSIT,USDC`;
    expect(() => validateCsvContent(bad)).toThrow(CsvValidationError);
  });

  it("parseCsvLine honours quoted commas and escaped quotes", () => {
    expect(parseCsvLine('"USDC,XLM",100')).toEqual(["USDC,XLM", "100"]);
    expect(parseCsvLine('"a""b",c')).toEqual(['a"b', "c"]);
  });
});
