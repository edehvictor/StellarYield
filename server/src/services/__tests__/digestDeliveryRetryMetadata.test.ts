import { DigestDeliveryService } from "../services/digest/DigestDeliveryService";
import type { DigestPayload } from "../services/digest/types";

const payload: DigestPayload = {
  walletAddress: "GABC",
  generatedAt: "2026-08-31T00:00:00.000Z",
  scheduleMode: "daily",
  clusters: [],
};

describe("DigestDeliveryService retry metadata", () => {
  it("marks missing email as terminal with machine-readable metadata", async () => {
    const service = new DigestDeliveryService(
      jest.fn().mockResolvedValue(null),
      jest.fn(),
      { maxRetries: 3, baseBackoffMs: 1000, now: () => new Date("2026-08-31T00:00:00.000Z") },
    );

    const result = await service.deliver(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("MISSING_EMAIL");
      expect(result.retry.status).toBe("terminal");
      expect(result.retry.nextRetryAt).toBeNull();
    }
  });

  it("returns temporary retry metadata while retry budget remains", async () => {
    const service = new DigestDeliveryService(
      jest.fn().mockResolvedValue("user@example.com"),
      jest.fn().mockRejectedValue(new Error("smtp unavailable")),
      { maxRetries: 3, baseBackoffMs: 1000, now: () => new Date("2026-08-31T00:00:00.000Z") },
    );

    const result = await service.deliver(payload, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("DELIVERY_FAILED");
      expect(result.retry.status).toBe("temporary");
      expect(result.retry.retryCount).toBe(1);
      expect(result.retry.backoffMs).toBe(2000);
      expect(result.retry.nextRetryAt).toBe("2026-08-31T00:00:02.000Z");
    }
  });

  it("marks failures as retry_exhausted after the retry budget is spent", async () => {
    const service = new DigestDeliveryService(
      jest.fn().mockResolvedValue("user@example.com"),
      jest.fn().mockRejectedValue(new Error("smtp unavailable")),
      { maxRetries: 2, baseBackoffMs: 1000, now: () => new Date("2026-08-31T00:00:00.000Z") },
    );

    const result = await service.deliver(payload, 2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retry.status).toBe("retry_exhausted");
      expect(result.retry.nextRetryAt).toBeNull();
    }
  });
});