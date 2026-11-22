import { describe, expect, it } from "vitest";
import {
  ContractContextMismatchError,
  createContractRegistryLoader,
} from "../src/contractRegistry";

describe("contract registry deployment context", () => {
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
});
