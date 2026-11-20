/**
 * rpcFallbackService.test.ts — Issue #1179
 *
 * Tests for RPC fallback rotation logging:
 * 1. Rotation log is populated on fallback
 * 2. Normal successful reads do not emit fallback logs
 * 3. Rotation reasons are derived correctly
 * 4. Retryable error classification works
 * 5. Log entries contain enough context for grouping
 */

import {
  isRetryableRpcError,
  deriveRotationReason,
  executeWithRpcFallback,
  getRotationLog,
  clearRotationLog,
  logRpcRotation,
  type RpcEndpoint,
} from "../services/rpcFallbackService";

describe("rpcFallbackService (#1179)", () => {
  beforeEach(() => {
    clearRotationLog();
  });

  describe("isRetryableRpcError", () => {
    it("returns true for ECONNREFUSED", () => {
      expect(isRetryableRpcError({ code: "ECONNREFUSED" })).toBe(true);
    });

    it("returns true for ENOTFOUND", () => {
      expect(isRetryableRpcError({ code: "ENOTFOUND" })).toBe(true);
    });

    it("returns true for ETIMEDOUT", () => {
      expect(isRetryableRpcError({ code: "ETIMEDOUT" })).toBe(true);
    });

    it("returns true for HTTP 500", () => {
      expect(isRetryableRpcError({ response: { status: 500 } })).toBe(true);
    });

    it("returns true for HTTP 503", () => {
      expect(isRetryableRpcError({ response: { status: 503 } })).toBe(true);
    });

    it("returns false for HTTP 400", () => {
      expect(isRetryableRpcError({ response: { status: 400 } })).toBe(false);
    });

    it("returns false for null", () => {
      expect(isRetryableRpcError(null)).toBe(false);
    });

    it("returns false for string errors", () => {
      expect(isRetryableRpcError("some string")).toBe(false);
    });

    it("returns true for timeout message in Error", () => {
      expect(isRetryableRpcError(new Error("Request timeout"))).toBe(true);
    });
  });

  describe("deriveRotationReason", () => {
    it("returns code-based reason for error code", () => {
      expect(deriveRotationReason({ code: "ECONNREFUSED" })).toBe("Error code: ECONNREFUSED");
    });

    it("returns HTTP status for HTTP errors", () => {
      expect(deriveRotationReason({ response: { status: 503 } })).toBe("HTTP 503");
    });

    it("returns timeout reason", () => {
      expect(deriveRotationReason(new Error("timeout occurred"))).toBe("Request timeout");
    });

    it("returns network error reason", () => {
      expect(deriveRotationReason(new Error("ECONNRESET"))).toBe("Network error");
    });

    it("returns server error reason", () => {
      expect(deriveRotationReason(new Error("500 Internal Server Error"))).toBe("Server error");
    });

    it("returns generic reason for unknown errors", () => {
      expect(deriveRotationReason(new Error("something else"))).toBe("Provider failure");
    });
  });

  describe("logRpcRotation", () => {
    it("adds entry to rotation log", () => {
      logRpcRotation({ originalProvider: "provider-a", route: "getBalance" }, "timeout");

      const log = getRotationLog();
      expect(log).toHaveLength(1);
      expect(log[0].originalProvider).toBe("provider-a");
      expect(log[0].route).toBe("getBalance");
      expect(log[0].reason).toBe("timeout");
      expect(log[0].timestamp).toBeDefined();
    });

    it("does not include sensitive data in log entry", () => {
      logRpcRotation({ originalProvider: "provider-a", route: "readBalance" }, "ECONNREFUSED");

      const log = getRotationLog();
      const entry = log[0];
      expect(entry.originalProvider).not.toContain("GABC");
      expect(entry.fallbackProvider).not.toContain("secret");
      expect(entry.reason).not.toContain("wallet");
    });
  });

  describe("executeWithRpcFallback", () => {
    const providers: RpcEndpoint[] = [
      { url: "https://rpc1.example.com", label: "rpc-primary" },
      { url: "https://rpc2.example.com", label: "rpc-fallback" },
    ];

    it("succeeds on first provider without logging rotation", async () => {
      const result = await executeWithRpcFallback(
        providers,
        async () => "success",
        "getBalance",
      );

      expect(result).toBe("success");
      expect(getRotationLog()).toHaveLength(0);
    });

    it("rotates to next provider on retryable error and logs rotation", async () => {
      let callCount = 0;
      const result = await executeWithRpcFallback(
        providers,
        async (provider) => {
          callCount++;
          if (provider.label === "rpc-primary") {
            throw { code: "ECONNREFUSED" };
          }
          return "fallback-success";
        },
        "getBalance",
      );

      expect(result).toBe("fallback-success");
      expect(callCount).toBe(2);

      const log = getRotationLog();
      expect(log).toHaveLength(1);
      expect(log[0].originalProvider).toBe("rpc-primary");
      expect(log[0].route).toBe("getBalance");
      expect(log[0].reason).toContain("Error code: ECONNREFUSED");
    });

    it("throws non-retryable errors immediately without rotation", async () => {
      const readFn = jest.fn().mockRejectedValue(new Error("Invalid request"));

      await expect(
        executeWithRpcFallback(providers, readFn, "getBalance"),
      ).rejects.toThrow("Invalid request");

      expect(readFn).toHaveBeenCalledTimes(1);
      expect(getRotationLog()).toHaveLength(0);
    });

    it("throws last error when all providers fail", async () => {
      const readFn = jest.fn().mockRejectedValue({ code: "ECONNREFUSED" });

      await expect(
        executeWithRpcFallback(providers, readFn, "getBalance"),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });

      expect(readFn).toHaveBeenCalledTimes(2);
      expect(getRotationLog()).toHaveLength(1);
    });

    it("does not emit fallback log for normal successful reads", async () => {
      await executeWithRpcFallback(
        providers,
        async () => "data",
        "readVault",
      );

      expect(getRotationLog()).toHaveLength(0);
    });
  });
});
