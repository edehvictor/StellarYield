import { validateTokenMapping, TokenMappingEntry } from "../tokenMappingValidationService";

const MAPPINGS: TokenMappingEntry[] = [
  { sourceNetwork: "stellar", sourceToken: "USDC", destNetwork: "ethereum", destToken: "USDC" },
  { sourceNetwork: "stellar", sourceToken: "XLM", destNetwork: "ethereum", destToken: "wXLM" },
];

describe("tokenMappingValidationService.validateTokenMapping (#1169)", () => {
  it("allows a supported token pair to quote normally", () => {
    const result = validateTokenMapping(MAPPINGS, "stellar", "USDC", "ethereum", "USDC");

    expect(result.supported).toBe(true);
    expect(result.code).toBe("supported");
  });

  it("blocks an unsupported pair where both tokens are individually known", () => {
    // USDC on stellar and wXLM on ethereum are each known, but never mapped to each other.
    const result = validateTokenMapping(MAPPINGS, "stellar", "USDC", "ethereum", "wXLM");

    expect(result.supported).toBe(false);
    expect(result.code).toBe("unsupported_pair");
  });

  it("blocks a partially mapped pair with an unknown source token", () => {
    const result = validateTokenMapping(MAPPINGS, "stellar", "BTC", "ethereum", "USDC");

    expect(result.supported).toBe(false);
    expect(result.code).toBe("unknown_source_token");
    expect(result.message).toContain("BTC");
  });

  it("blocks a partially mapped pair with an unknown destination token", () => {
    const result = validateTokenMapping(MAPPINGS, "stellar", "USDC", "polygon", "USDC");

    expect(result.supported).toBe(false);
    expect(result.code).toBe("unknown_dest_token");
    expect(result.message).toContain("polygon");
  });
});
