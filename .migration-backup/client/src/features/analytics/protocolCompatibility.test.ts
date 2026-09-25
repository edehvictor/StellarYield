import { describe, it, expect } from "vitest";
import {
  checkProtocolCompatibility,
  isFullySupported,
  isIncompatible,
  summariseMatrix,
} from "./protocolCompatibility";

// ── checkProtocolCompatibility — supported combinations ──────────────────────

describe("checkProtocolCompatibility — supported combinations", () => {
  it("classifies soroban::rpc as supported", () => {
    const result = checkProtocolCompatibility("soroban", "rpc");
    expect(result.tier).toBe("supported");
    expect(result.message).toBeTruthy();
  });

  it("classifies horizon::rest-api as supported", () => {
    const result = checkProtocolCompatibility("horizon", "rest-api");
    expect(result.tier).toBe("supported");
  });

  it("classifies horizon::websocket as supported", () => {
    expect(checkProtocolCompatibility("horizon", "websocket").tier).toBe("supported");
  });

  it("classifies stellar-anchor::rest-api as supported", () => {
    expect(checkProtocolCompatibility("stellar-anchor", "rest-api").tier).toBe("supported");
  });

  it("classifies aqua::rest-api as supported", () => {
    expect(checkProtocolCompatibility("aqua", "rest-api").tier).toBe("supported");
  });

  it("classifies aqua::graphql as supported", () => {
    expect(checkProtocolCompatibility("aqua", "graphql").tier).toBe("supported");
  });

  it("classifies phoenix::rest-api as supported", () => {
    expect(checkProtocolCompatibility("phoenix", "rest-api").tier).toBe("supported");
  });

  it("classifies blend::rpc as supported", () => {
    expect(checkProtocolCompatibility("blend", "rpc").tier).toBe("supported");
  });
});

// ── checkProtocolCompatibility — partial combinations ───────────────────────

describe("checkProtocolCompatibility — partial (degraded) combinations", () => {
  it("classifies soroban::rest-api as partial with a polling caveat", () => {
    const result = checkProtocolCompatibility("soroban", "rest-api");
    expect(result.tier).toBe("partial");
    expect(result.message.toLowerCase()).toMatch(/poll/);
  });

  it("classifies soroban::graphql as partial", () => {
    expect(checkProtocolCompatibility("soroban", "graphql").tier).toBe("partial");
  });

  it("classifies horizon::graphql as partial", () => {
    expect(checkProtocolCompatibility("horizon", "graphql").tier).toBe("partial");
  });

  it("classifies stellar-anchor::websocket as partial", () => {
    const result = checkProtocolCompatibility("stellar-anchor", "websocket");
    expect(result.tier).toBe("partial");
    expect(result.message).toBeTruthy();
  });

  it("classifies aqua::websocket as partial (rate-limited)", () => {
    const result = checkProtocolCompatibility("aqua", "websocket");
    expect(result.tier).toBe("partial");
    expect(result.message.toLowerCase()).toMatch(/rate/);
  });

  it("classifies phoenix::graphql as partial (beta)", () => {
    const result = checkProtocolCompatibility("phoenix", "graphql");
    expect(result.tier).toBe("partial");
    expect(result.message.toLowerCase()).toMatch(/beta/);
  });

  it("classifies blend::rest-api as partial", () => {
    expect(checkProtocolCompatibility("blend", "rest-api").tier).toBe("partial");
  });

  it("classifies blend::graphql as partial", () => {
    expect(checkProtocolCompatibility("blend", "graphql").tier).toBe("partial");
  });
});

// ── checkProtocolCompatibility — incompatible combinations ──────────────────

describe("checkProtocolCompatibility — incompatible combinations", () => {
  it("classifies soroban::websocket as incompatible", () => {
    const result = checkProtocolCompatibility("soroban", "websocket");
    expect(result.tier).toBe("incompatible");
    expect(result.message).toBeTruthy();
  });

  it("classifies soroban::ipfs as incompatible", () => {
    expect(checkProtocolCompatibility("soroban", "ipfs").tier).toBe("incompatible");
  });

  it("classifies horizon::rpc as incompatible", () => {
    expect(checkProtocolCompatibility("horizon", "rpc").tier).toBe("incompatible");
  });

  it("classifies horizon::ipfs as incompatible", () => {
    expect(checkProtocolCompatibility("horizon", "ipfs").tier).toBe("incompatible");
  });

  it("classifies stellar-anchor::graphql as incompatible", () => {
    expect(checkProtocolCompatibility("stellar-anchor", "graphql").tier).toBe("incompatible");
  });

  it("classifies stellar-anchor::rpc as incompatible", () => {
    expect(checkProtocolCompatibility("stellar-anchor", "rpc").tier).toBe("incompatible");
  });

  it("classifies aqua::rpc as incompatible", () => {
    expect(checkProtocolCompatibility("aqua", "rpc").tier).toBe("incompatible");
  });

  it("classifies phoenix::rpc as incompatible", () => {
    expect(checkProtocolCompatibility("phoenix", "rpc").tier).toBe("incompatible");
  });

  it("classifies blend::websocket as incompatible", () => {
    expect(checkProtocolCompatibility("blend", "websocket").tier).toBe("incompatible");
  });

  it("classifies blend::ipfs as incompatible", () => {
    expect(checkProtocolCompatibility("blend", "ipfs").tier).toBe("incompatible");
  });

  it("carries a non-empty degradation message for every incompatible entry", () => {
    const incompatiblePairs = [
      ["soroban", "websocket"],
      ["horizon", "rpc"],
      ["stellar-anchor", "graphql"],
      ["aqua", "ipfs"],
      ["phoenix", "ipfs"],
      ["blend", "websocket"],
    ] as const;
    for (const [p, d] of incompatiblePairs) {
      const result = checkProtocolCompatibility(p, d);
      expect(result.message.length, `${p}::${d} has empty message`).toBeGreaterThan(0);
    }
  });
});

// ── checkProtocolCompatibility — unknown combinations ───────────────────────

describe("checkProtocolCompatibility — unknown / future combinations", () => {
  it("returns 'unknown' for a protocol not in the matrix", () => {
    const result = checkProtocolCompatibility("future-protocol", "rest-api");
    expect(result.tier).toBe("unknown");
  });

  it("returns 'unknown' for a dataSource not in the matrix", () => {
    const result = checkProtocolCompatibility("soroban", "grpc");
    expect(result.tier).toBe("unknown");
  });

  it("returns a non-empty message even for unknown pairs", () => {
    const result = checkProtocolCompatibility("unknown-proto", "unknown-ds");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("is deterministic — same pair always yields the same result", () => {
    const r1 = checkProtocolCompatibility("soroban", "rpc");
    const r2 = checkProtocolCompatibility("soroban", "rpc");
    expect(r1.tier).toBe(r2.tier);
    expect(r1.message).toBe(r2.message);
  });
});

// ── isFullySupported ─────────────────────────────────────────────────────────

describe("isFullySupported", () => {
  it("returns true for fully supported pairs", () => {
    expect(isFullySupported("soroban", "rpc")).toBe(true);
    expect(isFullySupported("horizon", "rest-api")).toBe(true);
    expect(isFullySupported("aqua", "graphql")).toBe(true);
  });

  it("returns false for partial pairs", () => {
    expect(isFullySupported("soroban", "rest-api")).toBe(false);
    expect(isFullySupported("blend", "graphql")).toBe(false);
  });

  it("returns false for incompatible pairs", () => {
    expect(isFullySupported("soroban", "websocket")).toBe(false);
    expect(isFullySupported("horizon", "ipfs")).toBe(false);
  });

  it("returns false for unknown pairs", () => {
    expect(isFullySupported("nonexistent", "rest-api")).toBe(false);
  });
});

// ── isIncompatible ───────────────────────────────────────────────────────────

describe("isIncompatible", () => {
  it("returns true for incompatible pairs", () => {
    expect(isIncompatible("soroban", "websocket")).toBe(true);
    expect(isIncompatible("horizon", "rpc")).toBe(true);
    expect(isIncompatible("blend", "ipfs")).toBe(true);
  });

  it("returns false for supported pairs", () => {
    expect(isIncompatible("soroban", "rpc")).toBe(false);
    expect(isIncompatible("horizon", "rest-api")).toBe(false);
  });

  it("returns false for partial pairs", () => {
    expect(isIncompatible("soroban", "graphql")).toBe(false);
  });

  it("returns false for unknown pairs", () => {
    expect(isIncompatible("future-proto", "websocket")).toBe(false);
  });
});

// ── summariseMatrix ──────────────────────────────────────────────────────────

describe("summariseMatrix", () => {
  it("counts tiers correctly across a mixed batch", () => {
    const pairs = [
      { protocol: "soroban",  dataSource: "rpc"      }, // supported
      { protocol: "soroban",  dataSource: "rest-api" }, // partial
      { protocol: "soroban",  dataSource: "websocket"}, // incompatible
      { protocol: "unknown",  dataSource: "rest-api" }, // unknown
    ];
    const summary = summariseMatrix(pairs);
    expect(summary.total).toBe(4);
    expect(summary.supported).toBe(1);
    expect(summary.partial).toBe(1);
    expect(summary.incompatible).toBe(1);
    expect(summary.unknown).toBe(1);
  });

  it("collects degradation messages for all non-supported entries", () => {
    const pairs = [
      { protocol: "soroban", dataSource: "rest-api"  }, // partial — should have message
      { protocol: "soroban", dataSource: "websocket" }, // incompatible — should have message
      { protocol: "soroban", dataSource: "rpc"       }, // supported — no message
    ];
    const summary = summariseMatrix(pairs);
    expect(summary.degradationMessages).toHaveLength(2);
    summary.degradationMessages.forEach((msg) => {
      expect(msg.length).toBeGreaterThan(0);
    });
  });

  it("returns all-zero counts for an empty batch", () => {
    const summary = summariseMatrix([]);
    expect(summary.total).toBe(0);
    expect(summary.supported).toBe(0);
    expect(summary.degradationMessages).toHaveLength(0);
  });

  it("returns all supported with no degradation messages for a fully healthy batch", () => {
    const pairs = [
      { protocol: "soroban",  dataSource: "rpc"      },
      { protocol: "horizon",  dataSource: "rest-api" },
      { protocol: "aqua",     dataSource: "graphql"  },
    ];
    const summary = summariseMatrix(pairs);
    expect(summary.supported).toBe(3);
    expect(summary.degradationMessages).toHaveLength(0);
  });

  it("handles an all-incompatible batch correctly", () => {
    const pairs = [
      { protocol: "soroban", dataSource: "websocket" },
      { protocol: "horizon", dataSource: "rpc"       },
      { protocol: "blend",   dataSource: "ipfs"      },
    ];
    const summary = summariseMatrix(pairs);
    expect(summary.incompatible).toBe(3);
    expect(summary.supported).toBe(0);
    expect(summary.degradationMessages).toHaveLength(3);
  });
});
