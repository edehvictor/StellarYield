import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyWalletSignatureError } from "../../../../shared/types/walletSignatureRejection";
import { reportSignatureRejection } from "./signatureRejectionApi";

const rejection = classifyWalletSignatureError("User rejected signing", {
  provider: "freighter",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reportSignatureRejection", () => {
  it("posts the classified code without raw provider text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "USER_REJECTED_SIGNATURE",
        retryable: true,
        remainingAttempts: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reportSignatureRejection({
      action: "portfolio_deposit",
      rejection,
      walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      completedSteps: 1,
      totalSteps: 2,
    });

    expect(result).toEqual({
      code: "USER_REJECTED_SIGNATURE",
      retryable: true,
      remainingAttempts: 2,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      action: "portfolio_deposit",
      provider: "freighter",
      code: "USER_REJECTED_SIGNATURE",
      completedSteps: 1,
      totalSteps: 2,
    });
    expect(JSON.stringify(body)).not.toContain("User rejected signing");
  });

  it("returns null when telemetry is offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(
      reportSignatureRejection({ action: "portfolio_deposit", rejection }),
    ).resolves.toBeNull();
  });

  it("returns null for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );

    await expect(
      reportSignatureRejection({ action: "portfolio_deposit", rejection }),
    ).resolves.toBeNull();
  });
});
