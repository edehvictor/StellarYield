import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  VaultClient,
  SdkEndpointError,
  EndpointConfigVersionConflictError,
  areDiagnosticsPrivacySafe,
} from "../src";

const CONTRACT_ID = "CACTUSFAKECONTRACTIDFORTESTING1234567890ABCDEF";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

describe("SDK endpoint configuration concurrency hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("normal operation", () => {
    it("versions ApiClient updates and returns defensive snapshots", () => {
      const client = new ApiClient({
        baseUrl: "https://primary.test///",
        fallbackUrls: ["https://backup.test"],
        timeoutMs: 1000,
      });

      expect(client.getEndpointConfigState().version).toBe(1);
      expect(client.getConfig().baseUrl).toBe("https://primary.test");

      const snapshot = client.getEndpointConfigState();
      (snapshot.config as any).baseUrl = "https://mutated.test";
      snapshot.config.fallbackUrls?.push("https://mutated-backup.test");
      expect(client.getConfig().baseUrl).toBe("https://primary.test");
      expect(client.getConfig().fallbackUrls).toEqual(["https://backup.test"]);

      const committed = client.configureEndpoint({ timeoutMs: 2500 });
      expect(committed.version).toBe(2);
      expect(client.getEndpointConfigVersion()).toBe(2);
      expect(client.getConfig().timeoutMs).toBe(2500);
    });

    it("serializes concurrent async updates so no independent patch is lost", async () => {
      const client = new ApiClient({ baseUrl: "https://api.test" });

      const patches = [
        { timeoutMs: 1100 },
        { maxRetries: 1 },
        { retryDelayMs: 7 },
      ];

      const results = await Promise.all(
        patches.map((patch) =>
          client.updateEndpointConfigSafely({
            change: async () => {
              await Promise.resolve();
              expect(client.isEndpointConfigUpdateInFlight()).toBe(true);
              return patch;
            },
          })
        )
      );

      expect(results.map((result) => result.version)).toEqual([2, 3, 4]);
      expect(results.every((result) => result.retries === 0)).toBe(true);
      expect(client.getConfig()).toMatchObject({
        timeoutMs: 1100,
        maxRetries: 1,
        retryDelayMs: 7,
      });
      expect(client.getEndpointConfigVersion()).toBe(4);
      expect(client.isEndpointConfigUpdateInFlight()).toBe(false);
    });

    it("versions VaultClient RPC endpoint updates and normalizes URLs", async () => {
      const vault = new VaultClient({
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: "https://rpc-primary.test///",
      });

      expect(vault.getEndpointConfigVersion()).toBe(1);
      expect(vault.rpcUrl).toBe("https://rpc-primary.test");

      const committed = vault.configureEndpoint("https://rpc-backup.test///");
      expect(committed.version).toBe(2);
      expect(vault.rpcUrl).toBe("https://rpc-backup.test");

      const result = await vault.updateEndpointConfigSafely({
        change: async () => ({ rpcUrl: "https://rpc-third.test" }),
      });
      expect(result.version).toBe(3);
      expect(vault.rpcUrl).toBe("https://rpc-third.test");
    });
  });

  describe("validation and execution failure", () => {
    it("preserves configuration and version when validation rejects a candidate", () => {
      const client = new ApiClient({
        baseUrl: "https://active.test",
        timeoutMs: 8000,
      });
      const before = client.getEndpointConfigState();

      expect(() => client.configureEndpoint({ baseUrl: "invalid-url" })).toThrow(
        SdkEndpointError
      );
      expect(client.getEndpointConfigState()).toEqual(before);

      const vault = new VaultClient({
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: "https://rpc.test",
      });
      expect(() => vault.configureEndpoint("ftp://rpc.test")).toThrow(SdkEndpointError);
      expect(vault.rpcUrl).toBe("https://rpc.test");
      expect(vault.getEndpointConfigVersion()).toBe(1);
    });

    it("rejects a stale expectedVersion with retryable, privacy-safe diagnostics", () => {
      const client = new ApiClient({ baseUrl: "https://api.test", timeoutMs: 4000 });
      const staleVersion = client.getEndpointConfigVersion();
      client.configureEndpoint({ maxRetries: 1 });

      let conflict: EndpointConfigVersionConflictError | undefined;
      try {
        client.configureEndpoint(
          { timeoutMs: 9000 },
          { expectedVersion: staleVersion }
        );
      } catch (error) {
        conflict = error as EndpointConfigVersionConflictError;
      }

      expect(conflict).toBeInstanceOf(EndpointConfigVersionConflictError);
      expect(conflict!.expectedVersion).toBe(staleVersion);
      expect(conflict!.currentVersion).toBe(2);
      expect(conflict!.retryable).toBe(true);
      expect(conflict!.diagnostics![0].code).toBe("CONFIG_VERSION_CONFLICT");
      expect(conflict!.diagnostics![0].stage).toBe("endpoint-configuration");
      expect(conflict!.diagnostics![1].code).toBe("STATE_PRESERVED");
      expect(areDiagnosticsPrivacySafe(conflict!.diagnostics!)).toBe(true);

      expect(client.getConfig()).toMatchObject({ timeoutMs: 4000, maxRetries: 1 });
      expect(client.getEndpointConfigVersion()).toBe(2);
    });

    it("preserves state when an async change callback throws", async () => {
      const client = new ApiClient({ baseUrl: "https://api.test" });
      const before = client.getEndpointConfigState();

      await expect(
        client.updateEndpointConfigSafely({
          change: async () => {
            throw new Error("upstream validation failed");
          },
        })
      ).rejects.toThrow("upstream validation failed");

      expect(client.getEndpointConfigState()).toEqual(before);
      expect(client.isEndpointConfigUpdateInFlight()).toBe(false);
    });
  });

  describe("safe retry", () => {
    it("refreshes a conflict detected between read and persist and keeps both updates", async () => {
      const client = new ApiClient({ baseUrl: "https://api.test" });
      const retryEvents: { expectedVersion: number; currentVersion: number; attempt: number }[] =
        [];
      let interleaved = false;

      const result = await client.updateEndpointConfigSafely({
        change: async () => {
          if (!interleaved) {
            interleaved = true;
            client.configureEndpoint({ retryDelayMs: 99 });
          }
          return { maxRetries: 4 };
        },
        onRetry: (event) => retryEvents.push(event),
      });

      expect(result.attempts).toBe(2);
      expect(result.retries).toBe(1);
      expect(result.version).toBe(3);
      expect(retryEvents).toEqual([
        { expectedVersion: 1, currentVersion: 2, attempt: 1 },
      ]);
      expect(client.getConfig()).toMatchObject({ retryDelayMs: 99, maxRetries: 4 });
    });

    it("allows an explicit-version conflict to be retried with the reported version", () => {
      const client = new ApiClient({ baseUrl: "https://api.test", timeoutMs: 4000 });
      const originalVersion = client.getEndpointConfigVersion();
      client.configureEndpoint({ maxRetries: 1 });

      let currentVersion = 0;
      try {
        client.configureEndpoint(
          { timeoutMs: 9000 },
          { expectedVersion: originalVersion }
        );
      } catch (error) {
        currentVersion = (error as EndpointConfigVersionConflictError).currentVersion;
      }

      client.configureEndpoint(
        { timeoutMs: 9000 },
        { expectedVersion: currentVersion }
      );

      expect(client.getConfig()).toMatchObject({ timeoutMs: 9000, maxRetries: 1 });
      expect(client.getEndpointConfigVersion()).toBe(3);
    });

    it("pins one endpoint configuration for the whole in-flight request", async () => {
      let release!: (response: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );
      vi.stubGlobal("fetch", fetchMock);

      const client = new ApiClient({ baseUrl: "https://api-one.test", maxRetries: 0 });
      const pending = client.getYields();
      client.configureEndpoint({ baseUrl: "https://api-two.test" });

      release(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      await expect(pending).resolves.toEqual([]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api-one.test/api/yields");
      expect(client.getConfig().baseUrl).toBe("https://api-two.test");
    });
  });
});
