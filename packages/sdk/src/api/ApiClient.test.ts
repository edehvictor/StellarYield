// packages/sdk/src/api/ApiClient.test.ts
import { describe, beforeEach, test, expect, vi } from "vitest";
import { ApiClient } from "./ApiClient";
import {
  ApiHttpError,
  ApiTimeoutError,
  ApiNetworkError,
  ApiCancelledError,
} from "../errors";

describe("ApiClient", () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({
      baseUrl: "https://api.stellaryield.local",
      maxRetries: 1,
      retryDelayMs: 10,
    });
    vi.restoreAllMocks();
  });

  test("successful GET request returns parsed JSON", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "healthy" }), { status: 200 })
    );

    const result = await client.getHealth();
    expect(result).toEqual({ status: "healthy" });
  });

  test("throws ApiHttpError with retryable=true on 429 Too Many Requests", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 429, statusText: "Too Many Requests" })
    );

    let error: ApiHttpError | undefined;
    try {
      await client.getHealth();
    } catch (err) {
      error = err as ApiHttpError;
    }

    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error?.status).toBe(429);
    expect(error?.retryable).toBe(true);
  });

  test("throws ApiHttpError with retryable=false on 400 Bad Request", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 400, statusText: "Bad Request" })
    );

    let error: ApiHttpError | undefined;
    try {
      await client.getHealth();
    } catch (err) {
      error = err as ApiHttpError;
    }

    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error?.status).toBe(400);
    expect(error?.retryable).toBe(false);
  });

  test("throws ApiTimeoutError on request timeout", async () => {
    vi.spyOn(global, "fetch").mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          setTimeout(() => reject(err), 10);
        })
    );

    let error: ApiTimeoutError | undefined;
    try {
      await client.getHealth();
    } catch (err) {
      error = err as ApiTimeoutError;
    }

    expect(error).toBeInstanceOf(ApiTimeoutError);
    expect(error?.retryable).toBe(true);
  });

  test("throws ApiCancelledError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    let error: ApiCancelledError | undefined;
    try {
      await client.getHealth({ signal: controller.signal });
    } catch (err) {
      error = err as ApiCancelledError;
    }

    expect(error).toBeInstanceOf(ApiCancelledError);
    expect(error?.retryable).toBe(false);
  });
});
