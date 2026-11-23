import {
  buildSandboxAdapterPayload,
  getProtocolAdapterConfig,
  runProtocolAdapterWithSandbox,
} from "../services/protocolAdapterSandbox";

describe("protocol adapter sandbox mode", () => {
  it("enables sandbox mode from env", () => {
    expect(getProtocolAdapterConfig({ PROTOCOL_ADAPTER_SANDBOX: "true" }).mode).toBe("sandbox");
    expect(getProtocolAdapterConfig({ PROTOCOL_ADAPTER_SANDBOX: "0" }).mode).toBe("live");
  });

  it("returns deterministic fixture payload for same seed and adapter", () => {
    const cfg = { mode: "sandbox" as const, fixtureSeed: "seed" };
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(buildSandboxAdapterPayload("Blend", cfg, now)).toEqual(
      buildSandboxAdapterPayload("Blend", cfg, now),
    );
  });

  it("does not call live adapter in sandbox mode", async () => {
    const live = jest.fn(async () => ({ bad: true }));
    const report = await runProtocolAdapterWithSandbox("Blend", live, {
      mode: "sandbox",
      fixtureSeed: "seed",
    });
    expect(live).not.toHaveBeenCalled();
    expect(report.mode).toBe("sandbox");
    expect(report.status).toBe("valid");
    expect(report.payload?.protocolName).toBe("Blend");
  });
});
