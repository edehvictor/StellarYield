import { describe, expect, it } from "vitest";
import { evaluateContractInterfaceVersion } from "../../../shared/types/contractInterface";

describe("contract interface version gate", () => {
  it("accepts same major version", () => {
    expect(evaluateContractInterfaceVersion("vault", "1.4.0").compatible).toBe(true);
  });

  it("rejects missing version", () => {
    expect(evaluateContractInterfaceVersion("vault", null).code).toBe(
      "CONTRACT_INTERFACE_VERSION_MISSING",
    );
  });

  it("rejects unsupported major version", () => {
    expect(evaluateContractInterfaceVersion("vault", "2.0.0").code).toBe(
      "CONTRACT_INTERFACE_VERSION_UNSUPPORTED",
    );
  });
});
