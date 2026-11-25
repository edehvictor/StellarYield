import { describe, expect, it } from "vitest";
import {
  buildTransparencySummaryUrl,
  getExpectedTransparencyNetwork,
  readTransparencySummaryResponse,
  TRANSPARENCY_SCHEMA_VERSION,
  type TransparencyContext,
} from "./transparencyContextClient";

const summary = {
  totalRevenueLumens: 100,
  totalBurnedTokens: 10,
  deflationaryRatio: 5,
  history: [{ date: "2026-11-24", revenue: 100, burned: 10 }],
};

const ctx = (ledger: number, network: TransparencyContext["network"] = "testnet"): TransparencyContext => ({
  network,
  ledger,
  version: TRANSPARENCY_SCHEMA_VERSION,
});

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("getExpectedTransparencyNetwork", () => {
  it("follows the configured passphrase and defaults to testnet", () => {
    expect(getExpectedTransparencyNetwork({})).toBe("testnet");
    expect(
      getExpectedTransparencyNetwork({ VITE_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015" }),
    ).toBe("mainnet");
    expect(getExpectedTransparencyNetwork({ VITE_NETWORK_PASSPHRASE: "custom" })).toBeNull();
  });
});

describe("buildTransparencySummaryUrl", () => {
  it("names the network, schema version and the last ledger shown", () => {
    expect(buildTransparencySummaryUrl("http://api", { network: "testnet", current: ctx(512) })).toBe(
      `http://api/api/transparency/summary?network=testnet&version=${TRANSPARENCY_SCHEMA_VERSION}&minLedger=512`,
    );
    expect(buildTransparencySummaryUrl("", { network: null, current: null })).toBe(
      `/api/transparency/summary?version=${TRANSPARENCY_SCHEMA_VERSION}`,
    );
  });
});

describe("readTransparencySummaryResponse", () => {
  const request = { network: "testnet" as const, current: ctx(1000) };

  it("accepts a newer snapshot on the same network", async () => {
    const result = await readTransparencySummaryResponse(response({ ...summary, context: ctx(1001) }), request);
    expect(result).toEqual({ kind: "accept", data: summary, context: ctx(1001) });
  });

  it("accepts a snapshot from an older server without context, unbound", async () => {
    const result = await readTransparencySummaryResponse(response(summary), request);
    expect(result).toEqual({ kind: "accept", data: summary, context: null });
  });

  it("keeps the current snapshot for an older ledger or another network", async () => {
    const older = await readTransparencySummaryResponse(response({ ...summary, context: ctx(999) }), request);
    expect(older).toMatchObject({ kind: "keep-current", error: { code: "TRANSPARENCY_LEDGER_REGRESSION" } });

    const otherNetwork = await readTransparencySummaryResponse(
      response({ ...summary, context: ctx(5000, "mainnet") }),
      request,
    );
    expect(otherNetwork).toMatchObject({ kind: "keep-current", error: { code: "TRANSPARENCY_NETWORK_MISMATCH" } });
  });

  it("keeps the current snapshot when the context is malformed", async () => {
    const result = await readTransparencySummaryResponse(
      response({ ...summary, context: { network: "testnet", ledger: "1001", version: "1" } }),
      request,
    );
    expect(result).toMatchObject({ kind: "keep-current", error: { code: "INVALID_TRANSPARENCY_CONTEXT" } });
  });

  it("maps a server 409 to keep-current and carries retryability", async () => {
    const behind = await readTransparencySummaryResponse(
      response({ code: "TRANSPARENCY_LEDGER_BEHIND", error: "behind", retryable: true }, 409),
      request,
    );
    expect(behind).toMatchObject({ kind: "keep-current", error: { code: "TRANSPARENCY_LEDGER_BEHIND", retryable: true } });

    const mismatch = await readTransparencySummaryResponse(
      response({ code: "TRANSPARENCY_NETWORK_MISMATCH", error: "wrong network", retryable: false }, 409),
      request,
    );
    expect(mismatch).toMatchObject({ kind: "keep-current", error: { retryable: false } });
  });

  it("throws for other failures so the caller keeps its snapshot", async () => {
    await expect(readTransparencySummaryResponse(response({ error: "x" }, 500), request)).rejects.toThrow(
      "Server returned 500",
    );
    await expect(
      readTransparencySummaryResponse(response({ ...summary, deflationaryRatio: 500 }), request),
    ).rejects.toThrow();
  });
});
