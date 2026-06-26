import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mapGoogleAuthError, refreshAccessToken } from "../routes/googleSheets";

describe("googleSheets route helpers", () => {
  it("maps invalid_grant to REAUTH_REQUIRED", () => {
    const mapped = mapGoogleAuthError(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    });

    expect(mapped.code).toBe("REAUTH_REQUIRED");
    expect(mapped.message).toContain("revoked");
  });

  it("maps insufficient scope errors", () => {
    const mapped = mapGoogleAuthError(403, {
      error: "insufficient_scope",
      error_description: "Request had insufficient authentication scopes.",
    });

    expect(mapped.code).toBe("INSUFFICIENT_SCOPE");
    expect(mapped.message).toContain("Sheets permission");
  });

  it("maps 401 to TOKEN_EXPIRED", () => {
    const mapped = mapGoogleAuthError(401, { error: "invalid_token" });
    expect(mapped.code).toBe("TOKEN_EXPIRED");
  });
});

describe("refreshAccessToken", () => {
  it("throws REAUTH_REQUIRED when Google returns invalid_grant", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({
          error: "invalid_grant",
          error_description: "Token has been revoked.",
        }),
      }) as Response;

    process.env.GOOGLE_CLIENT_ID = "test-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";

    await expect(refreshAccessToken("revoked-token")).rejects.toMatchObject({
      code: "REAUTH_REQUIRED",
    });

    global.fetch = originalFetch;
  });
});
