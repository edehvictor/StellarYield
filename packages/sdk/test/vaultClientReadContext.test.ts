import { describe, it, expect, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { VaultClient, YIELD_VAULT_SPEC_HASH } from "../src";

describe("VaultClient read context binding (#1884)", () => {
  const contractId = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";
  const networkPassphrase = Networks.TESTNET;
  const configFingerprint = "simcfg1:0123456789abcdef";
  const account = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  function createClient(): VaultClient {
    return new VaultClient({
      contractId,
      networkPassphrase,
      rpcUrl: "https://soroban-testnet.stellar.org",
      specHash: YIELD_VAULT_SPEC_HASH,
      configFingerprint,
    });
  }

  function matchingContext() {
    return {
      networkPassphrase,
      specHash: YIELD_VAULT_SPEC_HASH,
      configFingerprint,
    };
  }

  it("exposes the read context and returns values under a matching expectation", async () => {
    const client = createClient();
    expect(client.getLifecycleContext()).toEqual({
      networkPassphrase,
      latestLedger: 0,
      validUntilLedger: 0,
      specHash: YIELD_VAULT_SPEC_HASH,
      configFingerprint,
    });

    const generated = (client as any).generatedClient;
    generated.total_assets = async () => ({ result: 1_000n });
    generated.total_shares = async () => ({ result: 500n });
    generated.get_shares = async () => ({ result: 42n });
    generated.get_admin = async () => ({ result: "GADMIN" });
    generated.get_token = async () => ({ result: "GTOKEN" });
    generated.get_flash_loan_fee = async () => ({ result: 7n });

    await expect(client.totalAssets(matchingContext())).resolves.toBe(1_000n);
    await expect(client.totalShares(matchingContext())).resolves.toBe(500n);
    await expect(client.getShares(account, matchingContext())).resolves.toBe(42n);
    await expect(client.getAdmin(matchingContext())).resolves.toBe("GADMIN");
    await expect(client.getToken(matchingContext())).resolves.toBe("GTOKEN");
    await expect(client.getFlashLoanFee(10n, matchingContext())).resolves.toBe(7n);
  });

  it("rejects a network mismatch before the read and retries safely", async () => {
    const client = createClient();
    const read = vi.fn(async () => ({ result: 9n }));
    (client as any).generatedClient.total_assets = read;

    await expect(
      client.totalAssets({ networkPassphrase: Networks.PUBLIC })
    ).rejects.toMatchObject({
      name: "LifecycleContextMismatchError",
      field: "network",
      phase: "simulate",
      retryable: true,
      statePreserved: true,
    });
    expect(read).not.toHaveBeenCalled();

    // The failed read changed nothing; the same client reads successfully.
    await expect(client.totalAssets({ networkPassphrase })).resolves.toBe(9n);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects a contract version mismatch before the read", async () => {
    const client = createClient();
    const read = vi.fn(async () => ({ result: 3n }));
    (client as any).generatedClient.get_shares = read;

    await expect(
      client.getShares(account, { specHash: "f".repeat(64) })
    ).rejects.toMatchObject({ field: "version", phase: "simulate" });

    await expect(
      client.getShares(account, { configFingerprint: "simcfg1:ffffffffffffffff" })
    ).rejects.toMatchObject({ field: "version" });

    expect(read).not.toHaveBeenCalled();
  });
});
