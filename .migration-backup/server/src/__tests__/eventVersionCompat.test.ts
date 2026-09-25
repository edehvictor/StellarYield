/**
 * Contract event version compatibility layer — Issue #1307.
 *
 * Normal path: legacy unversioned + versioned v1 envelopes normalize.
 * Edge cases: future versions → typed UNSUPPORTED_EVENT_VERSION;
 *             unknown topics / malformed envelopes → typed errors
 *             (never raw provider message parsing).
 */
import {
  checkEventVersion,
  EventCompatError,
  EVENT_SCHEMA_VERSION,
  isKnownEventType,
  normalizeContractEvent,
  normalizeEventType,
} from "../indexer/eventVersionCompat";

describe("eventVersionCompat (#1307)", () => {
  it("exposes schema version 1", () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("normalizes a legacy unversioned deposit envelope to v1", () => {
    expect(normalizeContractEvent(["deposit"])).toMatchObject({
      eventType: "deposit",
      rawType: "deposit",
      schemaVersion: 1,
      status: "Recognized",
    });
  });

  it("normalizes a versioned (topic, version) tuple envelope", () => {
    expect(normalizeContractEvent(["withdraw", "1"])).toMatchObject({
      eventType: "withdraw",
      schemaVersion: 1,
      status: "Recognized",
    });
  });

  it("resolves aliases to canonical types", () => {
    expect(normalizeEventType("withdrawal")).toBe("withdraw");
    expect(normalizeEventType("dep_for")).toBe("deposit_for");
    expect(normalizeContractEvent(["dep_for"]).eventType).toBe("deposit_for");
  });

  it("rejects future versions with a typed UNSUPPORTED_EVENT_VERSION error", () => {
    let caught: unknown;
    try {
      normalizeContractEvent(["deposit", "2"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EventCompatError);
    expect((caught as EventCompatError).code).toBe(
      "UNSUPPORTED_EVENT_VERSION",
    );
  });

  it("rejects suffixed future topics (deposit_v2) deterministically", () => {
    expect(() =>
      normalizeContractEvent(["deposit_v2"]),
    ).toThrowError(/not supported/);
    try {
      normalizeContractEvent(["deposit_v2"]);
    } catch (err) {
      expect((err as EventCompatError).code).toBe(
        "UNSUPPORTED_EVENT_VERSION",
      );
    }
  });

  it("rejects unknown topics with a typed UNKNOWN_EVENT_TYPE error", () => {
    try {
      normalizeContractEvent(["no_such_event"]);
      fail("should have thrown");
    } catch (err) {
      expect((err as EventCompatError).code).toBe("UNKNOWN_EVENT_TYPE");
    }
    expect(isKnownEventType("no_such_event")).toBe(false);
  });

  it("rejects empty envelopes and bad version literals as INVALID", () => {
    expect(() => normalizeContractEvent([])).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT_ENVELOPE" }),
    );
    expect(() => normalizeContractEvent(["deposit", "later"])).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT_ENVELOPE" }),
    );
  });

  it("gates versions deterministically (v1 recognized, v2 unknown, v0 invalid)", () => {
    expect(checkEventVersion("deposit", 1)).toBe("Recognized");
    expect(checkEventVersion("deposit", 2)).toBe("Unknown");
    expect(checkEventVersion("deposit", 0)).toBe("Invalid");
    expect(checkEventVersion("no_such_event", 1)).toBe("Invalid");
  });

  it("recognizes all live vault v1 topics", () => {
    for (const topic of [
      "init",
      "deposit",
      "dep_for",
      "withdraw",
      "rebal",
      "tr_sh",
      "strat_cfg",
      "harvest",
    ]) {
      expect(isKnownEventType(topic)).toBe(true);
      expect(normalizeContractEvent([topic]).status).toBe("Recognized");
    }
  });
});
