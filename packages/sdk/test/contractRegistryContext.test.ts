import { describe, expect, it } from "vitest";
import {
  ContractContextMismatchError,
  createContractRegistryLoader,
} from "../src/contractRegistry";

describe("contract registry deployment context", () => {
  it("resolves a matching deployment without mutating the registry", () => {
    const registry = {
      testnet: { vault: { id: " C-test ", network: "testnet", ledger: 100, version: "v2" } },
      mainnet: {},
      local: {},
    } as const;
    const loader = createContractRegistryLoader(registry);

    expect(loader.requireContractIdForContext("vault", {
      network: "testnet",
      ledger: 101,
      version: "v2",
    })).toBe("C-test");
    expect(registry.testnet.vault.id).toBe(" C-test ");
  });

  it("rejects a registry entry from another network", () => {
    const loader = createContractRegistryLoader({
      testnet: { vault: { id: "C-test", network: "mainnet" } },
      mainnet: {},
      local: {},
    });
    expect(() => loader.resolveForContext("vault", { network: "testnet" }))
      .toThrow(ContractContextMismatchError);
  });

  it("rejects stale ledger and version contexts", () => {
    const loader = createContractRegistryLoader({
      testnet: { vault: { id: "C-test", network: "testnet", ledger: 100, version: "v2" } },
      mainnet: {},
      local: {},
    });
    expect(() => loader.resolveForContext("vault", { network: "testnet", ledger: 99, version: "v2" }))
      .toThrow("valid from ledger");
    expect(() => loader.resolveForContext("vault", { network: "testnet", ledger: 100, version: "v1" }))
      .toThrow("version");
  });

  it("requires context for metadata and can safely retry with a corrected context", () => {
    const loader = createContractRegistryLoader({
      testnet: { vault: { id: "C-test", network: "testnet", ledger: 100, version: "v2" } },
      mainnet: {},
      local: {},
    });

    expect(() => loader.resolveForContext("vault", { network: "testnet" }))
      .toThrow(/requires (ledger|version) context/);
    expect(loader.requireContractIdForContext("vault", {
      network: "testnet",
      ledger: 100,
      version: "v2",
    })).toBe("C-test");
  });

  it("does not use a fallback-network address for an explicit context", () => {
    const loader = createContractRegistryLoader({
      testnet: { vault: "C-test" },
      mainnet: {},
      local: {},
    });

    expect(() => loader.resolveForContext("vault", { network: "local" }))
      .toThrow("resolved from testnet");
  });
});
