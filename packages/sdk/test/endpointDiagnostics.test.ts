import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  VaultClient,
  SdkEndpointError,
  ApiHttpError,
  ApiNetworkError,
  ApiTimeoutError,
  InvalidAmountError,
  ContractExecutionError,
  areDiagnosticsPrivacySafe,
  redactDiagnosticText,
  validateEndpointConfig,
  validateEndpointUrl,
  createMemoryCacheStore,
  type SdkDiagnostic,
} from "../src";

describe("SDK Endpoint Configuration & Diagnostic Context Hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("Normal operation", () => {
    it("initializes ApiClient with valid baseUrl and normalizes trailing slashes", () => {
      const client = new ApiClient({
        baseUrl: "https://api.stellaryield.com///",
        timeoutMs: 5000,
      });

      expect(client.getConfig().baseUrl).toBe("https://api.stellaryield.com");
      expect(client.getRegisteredEndpoints().length).toBeGreaterThan(0);
    });

    it("initializes VaultClient with valid Soroban RPC endpoint", () => {
      const vault = new VaultClient({
        contractId: "CACTUSFAKECONTRACTIDFORTESTING1234567890ABCDEF",
        networkPassphrase: "Test SDF Network ; September 2015",
        rpcUrl: "https://soroban-testnet.stellar.org///",
      });

      expect(vault.rpcUrl).toBe("https://soroban-testnet.stellar.org");
      expect(typeof vault.deposit).toBe("function");
    });

    it("allows updating endpoint configuration with valid parameters", () => {
      const client = new ApiClient({
        baseUrl: "https://primary.stellaryield.com",
      });

      client.configureEndpoint({
        baseUrl: "https://backup.stellaryield.com",
        timeoutMs: 10000,
      });

      expect(client.getConfig().baseUrl).toBe("https://backup.stellaryield.com");
      expect(client.getConfig().timeoutMs).toBe(10000);
    });

    it("allows VaultClient endpoint reconfiguration with a valid URL", () => {
      const vault = new VaultClient({
        contractId: "CACTUSFAKECONTRACTIDFORTESTING1234567890ABCDEF",
        networkPassphrase: "Test SDF Network ; September 2015",
        rpcUrl: "https://soroban-testnet.stellar.org",
      });

      vault.configureEndpoint("https://soroban-backup.stellar.org");
      expect(vault.rpcUrl).toBe("https://soroban-backup.stellar.org");
    });
  });

  describe("Validation failure and privacy-safe diagnostics", () => {
    it("rejects invalid or empty endpoint URLs with privacy-safe diagnostics", () => {
      const testCases = [
        "",
        "   ",
        "ftp://internal.rpc.vault",
        "javascript:alert(1)",
        "not-a-valid-url",
      ];

      for (const invalidUrl of testCases) {
        expect(() => new ApiClient({ baseUrl: invalidUrl })).toThrow(SdkEndpointError);

        try {
          new ApiClient({ baseUrl: invalidUrl });
        } catch (err) {
          const endpointErr = err as SdkEndpointError;
          expect(endpointErr.phase).toBe("simulate");
          expect(endpointErr.retryable).toBe(false);
          expect(endpointErr.diagnostics).toBeDefined();

          const [primary, statePreserved] = endpointErr.diagnostics!;
          expect(primary.code).toBe("VALIDATION_FAILED");
          expect(primary.stage).toBe("endpoint-configuration");
          expect(primary.retryable).toBe(false);
          expect(primary.privacySafe).toBe(true);

          expect(statePreserved.code).toBe("STATE_PRESERVED");
          expect(statePreserved.stage).toBe("state-persistence");
          expect(statePreserved.affectedStages).toEqual(["endpoint-configuration"]);

          expect(areDiagnosticsPrivacySafe(endpointErr.diagnostics!)).toBe(true);
        }
      }
    });

    it("rejects endpoint URLs containing embedded user credentials and redacts them", () => {
      const credentialUrl = "https://admin:superSecretToken123@api.stellaryield.com";

      expect(() => new ApiClient({ baseUrl: credentialUrl })).toThrow(SdkEndpointError);

      try {
        new ApiClient({ baseUrl: credentialUrl });
      } catch (err) {
        const endpointErr = err as SdkEndpointError;
        const serialized = JSON.stringify(endpointErr.diagnostics);

        expect(serialized).not.toContain("superSecretToken123");
        expect(serialized).not.toContain("admin:");
        expect(areDiagnosticsPrivacySafe(endpointErr.diagnostics!)).toBe(true);
      }
    });

    it("rejects invalid fallback URLs and negative timeout configuration", () => {
      const validation = validateEndpointConfig({
        baseUrl: "https://api.stellaryield.com",
        fallbackUrls: ["invalid-fallback-url"],
        timeoutMs: -500,
        maxRetries: -1,
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.diagnostics.length).toBe(2);
      expect(validation.diagnostics[0].code).toBe("VALIDATION_FAILED");
      expect(validation.diagnostics[1].code).toBe("STATE_PRESERVED");
      expect(areDiagnosticsPrivacySafe(validation.diagnostics)).toBe(true);
    });

    it("rejects invalid RPC URLs in VaultClient", () => {
      expect(
        () =>
          new VaultClient({
            contractId: "CACTUS",
            networkPassphrase: "Test SDF Network ; September 2015",
            rpcUrl: "invalid-rpc",
          })
      ).toThrow(SdkEndpointError);
    });
  });

  describe("Insufficient diagnostic context handling", () => {
    it("handles opaque empty error bodies safely by attaching CONTEXT_INSUFFICIENT and STATE_PRESERVED", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("", { status: 500, statusText: "Internal Server Error" })
        )
      );

      const client = new ApiClient({
        baseUrl: "https://api.stellaryield.com",
        maxRetries: 0,
      });

      let capturedError: ApiHttpError | undefined;
      try {
        await client.getHealth();
      } catch (err) {
        capturedError = err as ApiHttpError;
      }

      expect(capturedError).toBeInstanceOf(ApiHttpError);
      expect(capturedError?.status).toBe(500);
      expect(capturedError?.diagnostics).toBeDefined();

      const diagnostics = capturedError!.diagnostics!;
      expect(diagnostics.map((d) => d.code)).toEqual([
        "CONTEXT_INSUFFICIENT",
        "STATE_PRESERVED",
      ]);
      expect(diagnostics[0].stage).toBe("network-dispatch");
      expect(diagnostics[0].remediation).toContain("existing state and account balances were preserved");
      expect(diagnostics[1].stage).toBe("state-persistence");
      expect(areDiagnosticsPrivacySafe(diagnostics)).toBe(true);
    });

    it("preserves server-supplied diagnostics when present and privacy-safe", async () => {
      const serverDiagnostics: SdkDiagnostic[] = [
        {
          code: "VALIDATION_FAILED",
          stage: "request-validation",
          severity: "warning",
          summary: "Request parameter validation failed.",
          remediation: "Correct input parameters and resubmit.",
          retryable: false,
          privacySafe: true,
        },
        {
          code: "STATE_PRESERVED",
          stage: "state-persistence",
          severity: "info",
          summary: "No state or balance changes were executed.",
          remediation: "No rollback required.",
          retryable: true,
          privacySafe: true,
        },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: "VALIDATION_FAILED",
              diagnostics: serverDiagnostics,
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          )
        )
      );

      const client = new ApiClient({
        baseUrl: "https://api.stellaryield.com",
        maxRetries: 0,
      });

      try {
        await client.getYields();
      } catch (err) {
        const httpErr = err as ApiHttpError;
        expect(httpErr.diagnostics).toEqual(serverDiagnostics);
        expect(areDiagnosticsPrivacySafe(httpErr.diagnostics!)).toBe(true);
      }
    });

    it("handles contract execution error with insufficient diagnostic events safely", () => {
      const errWithoutEvents = new ContractExecutionError(
        5,
        "Unauthorized",
        "Caller is unauthorized",
        undefined,
        [] // empty diagnostic events -> insufficient diagnostic context
      );

      expect(errWithoutEvents.diagnostics).toBeDefined();
      const [primary, statePreserved] = errWithoutEvents.diagnostics!;
      expect(primary.code).toBe("CONTEXT_INSUFFICIENT");
      expect(primary.stage).toBe("submit");
      expect(statePreserved.code).toBe("STATE_PRESERVED");
      expect(statePreserved.stage).toBe("state-persistence");
      expect(areDiagnosticsPrivacySafe(errWithoutEvents.diagnostics!)).toBe(true);
    });

    it("redacts sensitive addresses, secret seeds, bearer tokens, URLs, and paths", () => {
      const sensitiveRaw =
        "Failed at https://admin:pass@rpc.internal:8000/v1 with seed SBX1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF and account GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF and Bearer eyJhbGciOiJIUzI1NiJ9.test and path C:\\secrets\\key.pem";

      const redacted = redactDiagnosticText(sensitiveRaw);
      expect(redacted).not.toContain("pass@");
      expect(redacted).not.toContain("SBX1234567890");
      expect(redacted).not.toContain("GABC1234567890");
      expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(redacted).not.toContain("C:\\secrets");
      expect(redacted).toContain("[redacted-url-with-auth]");
      expect(redacted).toContain("[redacted-address]");
      expect(redacted).toContain("[redacted-token]");
    });
  });

  describe("Preservation of existing state and balances", () => {
    it("preserves previous endpoint configuration when dynamic reconfiguration fails", () => {
      const client = new ApiClient({
        baseUrl: "https://active.stellaryield.com",
        timeoutMs: 8000,
      });

      expect(() =>
        client.configureEndpoint({
          baseUrl: "invalid-new-url",
        })
      ).toThrow(SdkEndpointError);

      // Previous valid configuration remains active and untouched
      expect(client.getConfig().baseUrl).toBe("https://active.stellaryield.com");
      expect(client.getConfig().timeoutMs).toBe(8000);
    });

    it("preserves cached balances and data in cache store when network requests fail", async () => {
      const store = createMemoryCacheStore();
      const client = new ApiClient({
        baseUrl: "https://api.stellaryield.com",
        cacheStore: store,
      });

      // Populate valid cached balance / yield payload
      const initialPayload = [{ protocol: "vault-1", apy: 14.5, tvl: 500000 }];
      await store.set("sy_api_get:/api/yields", {
        data: initialPayload,
        fetchedAt: Date.now(),
      });

      // Network fails with 503 Service Unavailable (insufficient diagnostic context)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("", { status: 503, statusText: "Service Unavailable" })
        )
      );

      const cachedResult = await client.cachedGet<typeof initialPayload>("/api/yields");

      // Verify cached balances are preserved and returned
      expect(cachedResult.fromCache).toBe(true);
      expect(cachedResult.data).toEqual(initialPayload);
      expect(cachedResult.offline).toBe(false);

      // Verify cache store data was not overwritten or wiped
      const entryInStore = await store.get("sy_api_get:/api/yields");
      expect(entryInStore?.data).toEqual(initialPayload);
    });

    it("attaches STATE_PRESERVED to token amount validation errors", () => {
      try {
        throw new InvalidAmountError("amount", "invalid-str", "must be a safe integer or decimal string");
      } catch (err) {
        const amountErr = err as InvalidAmountError;
        expect(amountErr.diagnostics).toBeDefined();

        const [primary, statePreserved] = amountErr.diagnostics!;
        expect(primary.code).toBe("VALIDATION_FAILED");
        expect(primary.stage).toBe("request-validation");
        expect(statePreserved.code).toBe("STATE_PRESERVED");
        expect(statePreserved.stage).toBe("state-persistence");
        expect(areDiagnosticsPrivacySafe(amountErr.diagnostics!)).toBe(true);
      }
    });
  });

  describe("Safe retry behavior", () => {
    it("marks configuration and request validation errors as non-retryable", () => {
      const validation = validateEndpointConfig({ baseUrl: "not-http://test" });
      expect(validation.diagnostics[0].retryable).toBe(false);
      expect(validation.diagnostics[0].code).toBe("VALIDATION_FAILED");
    });

    it("marks transient endpoint outages as retryable and recovers on retry", async () => {
      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return new Response("", { status: 503, statusText: "Service Unavailable" });
          }
          return new Response(JSON.stringify({ database: "healthy" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        })
      );

      const client = new ApiClient({
        baseUrl: "https://api.stellaryield.com",
        maxRetries: 2,
        retryDelayMs: 10,
        retryableStatuses: [503],
      });

      const result = await client.getHealth();
      expect(result.database).toBe("healthy");
      expect(callCount).toBe(2);
    });

    it("allows immediate safe retry with corrected parameters after validation failure", () => {
      const client = new ApiClient({
        baseUrl: "https://initial.stellaryield.com",
      });

      // 1. Invalid attempt fails validation and preserves state
      expect(() =>
        client.configureEndpoint({ baseUrl: "invalid-url" })
      ).toThrow(SdkEndpointError);

      // 2. Corrected retry succeeds cleanly
      expect(() =>
        client.configureEndpoint({ baseUrl: "https://valid.stellaryield.com" })
      ).not.toThrow();

      expect(client.getConfig().baseUrl).toBe("https://valid.stellaryield.com");
    });
  });
});
