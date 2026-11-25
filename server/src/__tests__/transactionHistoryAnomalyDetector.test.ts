import {
  TransactionHistoryAnomalyDetector,
  TransactionHistoryAnomalyError,
  TRANSACTION_ANOMALY_CODES,
  type Transaction,
} from "../services/transactionHistoryAnomalyDetector";

describe("TransactionHistoryAnomalyDetector", () => {
  const detector = new TransactionHistoryAnomalyDetector();

  it("returns no anomalies for empty input", () => {
    expect(detector.detectAnomalies([])).toEqual([]);
  });

  it("detects unusually large transactions", () => {
    const txs: Transaction[] = [
      { id: "t1", amount: 1_000_001, timestamp: new Date("2026-01-01T00:00:00Z"), type: "deposit" },
    ];

    expect(detector.detectAnomalies(txs)).toEqual([
      {
        transactionId: "t1",
        reason: "Unusually large transaction amount detected",
        severity: "high",
        code: TRANSACTION_ANOMALY_CODES.LARGE_AMOUNT,
      },
    ]);
  });

  it("does not flag amount exactly at threshold", () => {
    const txs: Transaction[] = [
      { id: "t1", amount: 1_000_000, timestamp: "2026-01-01T00:00:00Z", type: "deposit" },
    ];

    expect(detector.detectAnomalies(txs)).toEqual([]);
  });

  it("detects rapid consecutive same-type transactions under default window", () => {
    const txs: Transaction[] = [
      { id: "t1", amount: 10, timestamp: "2026-01-01T00:00:00.000Z", type: "withdrawal" },
      { id: "t2", amount: 20, timestamp: "2026-01-01T00:00:04.999Z", type: "withdrawal" },
    ];

    expect(detector.detectAnomalies(txs)).toEqual([
      {
        transactionId: "t2",
        reason: "High frequency of identical transaction types",
        severity: "medium",
        code: TRANSACTION_ANOMALY_CODES.RAPID_CONSECUTIVE,
      },
    ]);
  });

  it("does not flag rapid transactions at exact window boundary or different types", () => {
    const boundary: Transaction[] = [
      { id: "t1", amount: 10, timestamp: 0, type: "transfer" },
      { id: "t2", amount: 20, timestamp: 5_000, type: "transfer" },
    ];
    const differentType: Transaction[] = [
      { id: "t1", amount: 10, timestamp: 0, type: "deposit" },
      { id: "t2", amount: 20, timestamp: 1_000, type: "withdrawal" },
    ];

    expect(detector.detectAnomalies(boundary)).toEqual([]);
    expect(detector.detectAnomalies(differentType)).toEqual([]);
  });

  it("returns deterministic ordering independent of input order", () => {
    const txs: Transaction[] = [
      { id: "b", amount: 2_000_000, timestamp: "2026-01-01T00:00:02Z", type: "deposit" },
      { id: "a", amount: 10, timestamp: "2026-01-01T00:00:01Z", type: "deposit" },
      { id: "c", amount: 10, timestamp: "2026-01-01T00:00:01.500Z", type: "deposit" },
    ];

    expect(detector.detectAnomalies(txs)).toEqual([
      {
        transactionId: "c",
        reason: "High frequency of identical transaction types",
        severity: "medium",
        code: TRANSACTION_ANOMALY_CODES.RAPID_CONSECUTIVE,
      },
      {
        transactionId: "b",
        reason: "Unusually large transaction amount detected",
        severity: "high",
        code: TRANSACTION_ANOMALY_CODES.LARGE_AMOUNT,
      },
      {
        transactionId: "b",
        reason: "High frequency of identical transaction types",
        severity: "medium",
        code: TRANSACTION_ANOMALY_CODES.RAPID_CONSECUTIVE,
      },
    ]);
  });

  it("supports option overrides", () => {
    const txs: Transaction[] = [
      { id: "t1", amount: 100, timestamp: "2026-01-01T00:00:00Z", type: "transfer" },
      { id: "t2", amount: 100, timestamp: "2026-01-01T00:00:10Z", type: "transfer" },
    ];

    expect(
      detector.detectAnomalies(txs, { largeAmountThreshold: 50, rapidWindowMs: 11_000 }),
    ).toEqual([
      {
        transactionId: "t1",
        reason: "Unusually large transaction amount detected",
        severity: "high",
        code: TRANSACTION_ANOMALY_CODES.LARGE_AMOUNT,
      },
      {
        transactionId: "t2",
        reason: "Unusually large transaction amount detected",
        severity: "high",
        code: TRANSACTION_ANOMALY_CODES.LARGE_AMOUNT,
      },
      {
        transactionId: "t2",
        reason: "High frequency of identical transaction types",
        severity: "medium",
        code: TRANSACTION_ANOMALY_CODES.RAPID_CONSECUTIVE,
      },
    ]);
  });

  it("throws typed errors for invalid input", () => {
    expect(() => detector.detectAnomalies(null as unknown as Transaction[])).toThrow(
      TransactionHistoryAnomalyError,
    );
    expect(() => detector.detectAnomalies([{} as Transaction])).toThrow(
      expect.objectContaining({ code: "INVALID_TRANSACTION_ID" }),
    );
    expect(() =>
      detector.detectAnomalies([
        { id: "t1", amount: -1, timestamp: "2026-01-01T00:00:00Z", type: "deposit" },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_TRANSACTION_AMOUNT" }));
    expect(() =>
      detector.detectAnomalies([
        { id: "t1", amount: 1, timestamp: "bad-date", type: "deposit" },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_TRANSACTION_TIMESTAMP" }));
    expect(() =>
      detector.detectAnomalies([
        { id: "t1", amount: 1, timestamp: "2026-01-01T00:00:00Z", type: "swap" as Transaction["type"] },
      ]),
    ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_TRANSACTION_TYPE" }));
    expect(() =>
      detector.detectAnomalies([], { largeAmountThreshold: -1 }),
    ).toThrow(expect.objectContaining({ code: "INVALID_OPTION" }));
  });
});
