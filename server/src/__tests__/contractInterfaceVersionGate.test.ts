import {
  assertContractWriteInterfaceVersion,
  checkContractInterfaceVersion,
} from "../services/contractInterfaceVersionGate";
import { ContractInterfaceVersionError } from "../../../shared/types/contractInterface";

describe("contract interface version gate", () => {
  const original = process.env.VAULT_CONTRACT_INTERFACE_VERSION;

  afterEach(() => {
    if (original === undefined) delete process.env.VAULT_CONTRACT_INTERFACE_VERSION;
    else process.env.VAULT_CONTRACT_INTERFACE_VERSION = original;
  });

  it("accepts matching major version", () => {
    process.env.VAULT_CONTRACT_INTERFACE_VERSION = "1.2.0";
    expect(assertContractWriteInterfaceVersion("vault").check.compatible).toBe(true);
  });

  it("rejects unsupported major version", () => {
    process.env.VAULT_CONTRACT_INTERFACE_VERSION = "2.0.0";
    expect(() => assertContractWriteInterfaceVersion("vault")).toThrow(
      ContractInterfaceVersionError,
    );
  });

  it("reports missing version as incompatible", () => {
    delete process.env.VAULT_CONTRACT_INTERFACE_VERSION;
    const result = checkContractInterfaceVersion("vault");
    expect(result.check.compatible).toBe(false);
    expect(result.check.code).toBe("CONTRACT_INTERFACE_VERSION_MISSING");
  });
});
