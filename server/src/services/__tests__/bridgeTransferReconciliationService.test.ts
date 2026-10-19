import {
  reconcileTransferStatus,
  BridgeTransferRecord,
} from "../bridgeTransferReconciliationService";

function baseRecord(overrides: Partial<BridgeTransferRecord> = {}): BridgeTransferRecord {
  return {
    transferId: "xfer-1",
    initiatedAt: "2026-06-15T00:00:00.000Z",
    lastCheckedAt: "2026-06-15T00:00:00.000Z",
    confirmationSource: null,
    state: "pending",
    lastKnownReason: null,
    ...overrides,
  };
}

describe("bridgeTransferReconciliationService.reconcileTransferStatus (#1168)", () => {
  it("stays pending within the confirmation window without a confirmation", () => {
    const record = baseRecord();
    const now = new Date("2026-06-15T00:10:00.000Z");

    const result = reconcileTransferStatus(record, { confirmed: false, source: "relayer-a" }, now);

    expect(result.state).toBe("pending");
    expect(result.transferId).toBe("xfer-1");
  });

  it("becomes delayed after the confirmation window elapses, without duplicating the record", () => {
    const record = baseRecord();
    const now = new Date("2026-06-15T01:00:00.000Z"); // 1hr later, past the 30min window

    const result = reconcileTransferStatus(record, { confirmed: false, source: "relayer-a" }, now);

    expect(result.state).toBe("delayed");
    expect(result.transferId).toBe(record.transferId);
    expect(result.lastCheckedAt).toBe(now.toISOString());
  });

  it("resolves to confirmed when the check reports confirmation", () => {
    const record = baseRecord({ state: "delayed" });
    const now = new Date("2026-06-15T02:00:00.000Z");

    const result = reconcileTransferStatus(
      record,
      { confirmed: true, source: "stellar-horizon" },
      now,
    );

    expect(result.state).toBe("confirmed");
    expect(result.confirmationSource).toBe("stellar-horizon");
    expect(result.lastKnownReason).toBeNull();
  });

  it("carries the latest known reason when a check reports failure", () => {
    const record = baseRecord({ state: "delayed" });
    const now = new Date("2026-06-15T02:00:00.000Z");

    const result = reconcileTransferStatus(
      record,
      { confirmed: false, source: "relayer-a", reason: "VAA rejected by guardian set" },
      now,
    );

    expect(result.state).toBe("failed");
    expect(result.lastKnownReason).toBe("VAA rejected by guardian set");
  });

  it("does not refresh a transfer that already reached a terminal state", () => {
    const record = baseRecord({ state: "confirmed", confirmationSource: "relayer-a" });
    const now = new Date("2026-06-16T00:00:00.000Z");

    const result = reconcileTransferStatus(record, { confirmed: false, source: "relayer-b" }, now);

    expect(result).toEqual(record);
  });
});
