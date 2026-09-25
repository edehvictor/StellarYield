import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/errors";
import { CancelTransactionIntentService } from "../services/transactionIntents/cancelTransactionIntentService";
import { InMemoryTransactionIntentRepository } from "./helpers/inMemoryTransactionIntentRepository";

const CLIENT_ID = "client-alpha";
const OTHER_CLIENT_ID = "client-beta";
const INTENT_ID = "11111111-1111-4111-8111-111111111111";

function setup() {
  const repository = new InMemoryTransactionIntentRepository();
  const service = new CancelTransactionIntentService(repository);

  return { repository, service };
}

async function expectApiError(
  promise: Promise<unknown>,
  expected: { code: string; status: number },
): Promise<ApiError> {
  let caught: unknown;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ApiError);
  const apiError = caught as ApiError;
  expect(apiError.code).toBe(expected.code);
  expect(apiError.status).toBe(expected.status);

  return apiError;
}

describe("CancelTransactionIntentService", () => {
  it("marks a pending intent owned by the client as cancelled", async () => {
    const { repository, service } = setup();
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });
    const now = new Date("2026-09-25T12:34:56.000Z");

    const result = await service.execute({
      intentId: INTENT_ID,
      clientId: CLIENT_ID,
      now,
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancelledAt).toEqual(now);
    expect(result.updatedAt).toEqual(now);
    expect(repository.get(INTENT_ID)?.status).toBe("cancelled");
    expect(repository.get(INTENT_ID)?.cancelledAt).toEqual(now);
  });

  it("cancels an intent whose payload is an empty structure", async () => {
    const { repository, service } = setup();
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID, payload: {} });

    const result = await service.execute({
      intentId: INTENT_ID,
      clientId: CLIENT_ID,
    });

    expect(result.status).toBe("cancelled");
    expect(result.payload).toEqual({});
  });

  it("returns a typed 404 when the intent does not exist", async () => {
    const { service } = setup();

    await expectApiError(
      service.execute({ intentId: INTENT_ID, clientId: CLIENT_ID }),
      { code: "INTENT_NOT_FOUND", status: 404 },
    );
  });

  it("returns a typed 404 when the intent was cleared from storage mid-flight", async () => {
    const { repository, service } = setup();
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });
    repository.cancelRace = { action: "delete" };

    await expectApiError(
      service.execute({ intentId: INTENT_ID, clientId: CLIENT_ID }),
      { code: "INTENT_NOT_FOUND", status: 404 },
    );
  });

  it("returns a typed 403 when the client identifier does not own the intent", async () => {
    const { repository, service } = setup();
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });

    await expectApiError(
      service.execute({ intentId: INTENT_ID, clientId: OTHER_CLIENT_ID }),
      { code: "INTENT_CLIENT_MISMATCH", status: 403 },
    );

    // Ownership is enforced before any write happens.
    expect(repository.get(INTENT_ID)?.status).toBe("pending");
  });

  it.each(["processed", "cleared", "cancelled"] as const)(
    "returns a typed 409 when the intent is already %s",
    async (status) => {
      const { repository, service } = setup();
      repository.seed({ id: INTENT_ID, clientId: CLIENT_ID, status });

      await expectApiError(
        service.execute({ intentId: INTENT_ID, clientId: CLIENT_ID }),
        { code: "INTENT_ALREADY_PROCESSED", status: 409 },
      );
    },
  );

  it("returns a typed 409 when the compare-and-set loses a race to execution", async () => {
    const { repository, service } = setup();
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });
    repository.cancelRace = { action: "setStatus", status: "processed" };

    await expectApiError(
      service.execute({ intentId: INTENT_ID, clientId: CLIENT_ID }),
      { code: "INTENT_ALREADY_PROCESSED", status: 409 },
    );
  });

  it("returns a stable typed 503 instead of the raw error when reads fail", async () => {
    const { repository, service } = setup();
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });
    const providerError = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    repository.failureMode = "read";
    repository.failureError = providerError;

    const apiError = await expectApiError(
      service.execute({ intentId: INTENT_ID, clientId: CLIENT_ID }),
      { code: "INTENT_SERVICE_UNAVAILABLE", status: 503 },
    );

    expect(apiError.message).toBe(
      "Transaction intent storage is temporarily unavailable. Please retry.",
    );
    expect(apiError.message).not.toContain("ECONNREFUSED");
    expect(apiError.cause).toBe(providerError);
    expect(JSON.stringify(apiError.toBody())).not.toContain("ECONNREFUSED");
  });

  it("returns a stable typed 503 instead of the raw error when writes fail", async () => {
    const { repository, service } = setup();
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });
    const providerError = new Error("timeout exceeded while waiting for lock");
    repository.failureMode = "write";
    repository.failureError = providerError;

    const apiError = await expectApiError(
      service.execute({ intentId: INTENT_ID, clientId: CLIENT_ID }),
      { code: "INTENT_SERVICE_UNAVAILABLE", status: 503 },
    );

    expect(apiError.message).toBe(
      "Transaction intent storage is temporarily unavailable. Please retry.",
    );
    expect(JSON.stringify(apiError.toBody())).not.toContain("timeout");

    // A failed write must never leave a half-cancelled intent behind.
    expect(repository.get(INTENT_ID)?.status).toBe("pending");
  });
});
