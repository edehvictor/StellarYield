/**
 * Cross-network token mapping validation (#1169).
 *
 * Checks a source/destination token pair against the known bridge mapping
 * table before quote generation, so unsupported assets are blocked early
 * with a clear, typed explanation rather than failing deep in execution.
 */

export interface TokenMappingEntry {
  sourceNetwork: string;
  sourceToken: string;
  destNetwork: string;
  destToken: string;
}

export type TokenMappingValidationCode =
  | "supported"
  | "unknown_source_token"
  | "unknown_dest_token"
  | "unsupported_pair";

export interface TokenMappingValidationResult {
  code: TokenMappingValidationCode;
  supported: boolean;
  message: string;
}

export function validateTokenMapping(
  mappings: TokenMappingEntry[],
  sourceNetwork: string,
  sourceToken: string,
  destNetwork: string,
  destToken: string,
): TokenMappingValidationResult {
  const sourceKnown = mappings.some(
    (m) => m.sourceNetwork === sourceNetwork && m.sourceToken === sourceToken,
  );
  if (!sourceKnown) {
    return {
      code: "unknown_source_token",
      supported: false,
      message: `"${sourceToken}" on ${sourceNetwork} is not a recognized bridgeable asset.`,
    };
  }

  const destKnown = mappings.some(
    (m) => m.destNetwork === destNetwork && m.destToken === destToken,
  );
  if (!destKnown) {
    return {
      code: "unknown_dest_token",
      supported: false,
      message: `"${destToken}" on ${destNetwork} is not a recognized bridgeable asset.`,
    };
  }

  const pairMapped = mappings.some(
    (m) =>
      m.sourceNetwork === sourceNetwork &&
      m.sourceToken === sourceToken &&
      m.destNetwork === destNetwork &&
      m.destToken === destToken,
  );
  if (!pairMapped) {
    return {
      code: "unsupported_pair",
      supported: false,
      message: `${sourceToken} (${sourceNetwork}) → ${destToken} (${destNetwork}) is not a supported bridge route.`,
    };
  }

  return {
    code: "supported",
    supported: true,
    message: `${sourceToken} (${sourceNetwork}) → ${destToken} (${destNetwork}) is supported.`,
  };
}
