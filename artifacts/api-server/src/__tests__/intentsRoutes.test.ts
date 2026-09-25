import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CancelTransactionIntentResponse } from "@workspace/api-zod";
import { createApp } from "../app";
import { CancelTransactionIntentService } from "../services/transactionIntents/cancelTransactionIntentService";
import { InMemoryTransactionIntentRepository } from "./helpers/inMemoryTransactionIntentRepository";

const CLIENT_ID = "client-alpha";
const OTHER_CLIENT_ID = "client-beta";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";

let server: Server;
let baseUrl: string;
let repository: InMemoryTransactionIntentRepository;

beforeAll(async () => {
  repository = new InMemoryTransactionIntentRepository();
  const app = createApp({
    cancelTransactionIntent: new CancelTransactionIntentService(repository),
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(
  () => new Promise<void>((resolve) => server.close(() => resolve())),
);

beforeEach(() => {
  repository.clear();
});

interface PostOptions {
  readonly clientIdHeader?: string;
  readonly rawBody?: string;
  readonly sendBody?: boolean;
}

async function postCancel(
  body: unknown,
  options: PostOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (options.clientIdHeader !== undefined) {
    headers["x-client-id"] = options.clientIdHeader;
  }

  return fetch(`${baseUrl}/intents/cancel`, {
    method: "POST",
    headers,
    ...(options.sendBody === false
      ? {}
      : { body: options.rawBody ?? JSON.stringify(body) }),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /api/intents/cancel", () => {
  it("returns 200 and marks a valid, authorized intent as cancelled", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: CLIENT_ID },
    );

    expect(response.status).toBe(200);
    const body = await readJson(response);

    // The payload must satisfy the generated OpenAPI response schema.
    expect(() => CancelTransactionIntentResponse.parse(body)).not.toThrow();

    const intent = (body["intent"] ?? {}) as Record<string, unknown>;
    expect(intent["id"]).toBe(INTENT_ID);
    expect(intent["clientId"]).toBe(CLIENT_ID);
    expect(intent["status"]).toBe("cancelled");
    expect(typeof intent["cancelledAt"]).toBe("string");
    expect(typeof intent["updatedAt"]).toBe("string");

    expect(repository.get(INTENT_ID)?.status).toBe("cancelled");
  });

  it("keeps the health route working (existing behavior preserved)", async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ status: "ok" });
  });

  it("returns typed 401 when the client identifier header is missing", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });

    const response = await postCancel({ intentId: INTENT_ID });

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      error: {
        code: "MISSING_CLIENT_IDENTIFIER",
        message:
          "A client identifier must be provided in the x-client-id header.",
      },
    });
    expect(repository.get(INTENT_ID)?.status).toBe("pending");
  });

  it("returns typed 401 when the client identifier header is blank", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: "   " },
    );

    expect(response.status).toBe(401);
    const body = await readJson(response);
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("MISSING_CLIENT_IDENTIFIER");
  });

  it("returns typed 401 when the client identifier fails the contract pattern", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: "not a valid id!" },
    );

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      error: {
        code: "INVALID_CLIENT_IDENTIFIER",
        message: "The provided x-client-id header is not a valid client identifier.",
      },
    });
    expect(repository.get(INTENT_ID)?.status).toBe("pending");
  });

  it("returns typed 403 for a mismatched client identifier", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: OTHER_CLIENT_ID },
    );

    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({
      error: {
        code: "INTENT_CLIENT_MISMATCH",
        message: "Transaction intent does not belong to this client.",
      },
    });
    expect(repository.get(INTENT_ID)?.status).toBe("pending");
  });

  it("returns typed 404 when the intent does not exist", async () => {
    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: CLIENT_ID },
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      error: {
        code: "INTENT_NOT_FOUND",
        message: "Transaction intent was not found.",
      },
    });
  });

  it("returns typed 409 when the intent has already been cleared", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID, status: "cleared" });

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: CLIENT_ID },
    );

    expect(response.status).toBe(409);
    const body = await readJson(response);
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("INTENT_ALREADY_PROCESSED");
  });

  it("returns typed 409 when the intent has already been processed", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID, status: "processed" });

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: CLIENT_ID },
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: {
        code: "INTENT_ALREADY_PROCESSED",
        message:
          "Transaction intent is no longer pending and cannot be cancelled.",
      },
    });
  });

  it("returns typed 400 with field details when intentId is missing", async () => {
    const response = await postCancel(
      {},
      { clientIdHeader: CLIENT_ID },
    );

    expect(response.status).toBe(400);
    const body = await readJson(response);
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("INVALID_REQUEST");
    expect(error["message"]).toBe("Request validation failed.");

    const details = error["details"] as Array<Record<string, string>>;
    expect(Array.isArray(details)).toBe(true);
    expect(details.some((detail) => detail["path"] === "intentId")).toBe(true);
  });

  it("returns typed 400 when intentId is not a UUID", async () => {
    const response = await postCancel(
      { intentId: "not-a-uuid" },
      { clientIdHeader: CLIENT_ID },
    );

    expect(response.status).toBe(400);
    const body = await readJson(response);
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("INVALID_REQUEST");
  });

  it("returns typed 400 instead of crashing when no body is sent at all", async () => {
    const response = await postCancel(
      {},
      { clientIdHeader: CLIENT_ID, sendBody: false },
    );

    expect(response.status).toBe(400);
    const body = await readJson(response);
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("INVALID_REQUEST");
  });

  it("returns typed 400 when the body is syntactically invalid JSON", async () => {
    const response = await postCancel(
      {},
      { clientIdHeader: CLIENT_ID, rawBody: "{invalid-json" },
    );

    expect(response.status).toBe(400);
    const body = await readJson(response);
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("INVALID_REQUEST");
  });

  it("returns a stable typed 503 without leaking provider errors when storage fails", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });
    repository.failureMode = "all";
    repository.failureError = new Error("connect ECONNREFUSED 10.0.0.5:5432");

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: CLIENT_ID },
    );

    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("10.0.0.5");

    const body = JSON.parse(raw) as Record<string, unknown>;
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("INTENT_SERVICE_UNAVAILABLE");
    expect(error["message"]).toBe(
      "Transaction intent storage is temporarily unavailable. Please retry.",
    );
  });

  it("leaves no intent state behind after a failed authorization attempt", async () => {
    repository.seed({ id: INTENT_ID, clientId: CLIENT_ID });

    const response = await postCancel(
      { intentId: INTENT_ID },
      { clientIdHeader: "another_client" },
    );

    expect(response.status).toBe(403);
    expect(repository.get(INTENT_ID)?.status).toBe("pending");
    expect(repository.get(INTENT_ID)?.cancelledAt).toBeNull();
  });
});
