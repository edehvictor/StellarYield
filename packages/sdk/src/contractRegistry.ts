/**
 * SDK contract registry loader.
 *
 * Resolves Soroban contract IDs for a target network from a registry object
 * (typically the parsed contents of `contracts/registry.json`), with
 * explicit overrides taking priority over registry values.
 *
 * Unlike the client/server registries, this loader also applies a
 * network-specific fallback chain: some networks (e.g. `local`) rarely have
 * their own deployed contracts, so a missing entry there can fall back to a
 * neighboring network's address for developer convenience. `testnet` and
 * `mainnet` never fall back into each other — silently resolving a mainnet
 * contract call against a testnet address (or vice versa) is a correctness
 * and safety hazard, not a convenience.
 */

export type ContractName =
  | "vault"
  | "zap"
  | "token"
  | "governance"
  | "strategy"
  | "emissionController"
  | "liquidStaking"
  | "stableswap"
  | "vesting";

export type NetworkName = "testnet" | "mainnet" | "local";

export type ContractRegistry = Record<NetworkName, Partial<Record<ContractName, string>>>;

export const CONTRACT_NAMES: ContractName[] = [
  "vault",
  "zap",
  "token",
  "governance",
  "strategy",
  "emissionController",
  "liquidStaking",
  "stableswap",
  "vesting",
];

/**
 * Per-network fallback order, consulted in sequence when the requested
 * network has no entry for a given contract. Deliberately does not include
 * `testnet`/`mainnet` as fallbacks for one another.
 */
export const NETWORK_FALLBACK_ORDER: Record<NetworkName, NetworkName[]> = {
  mainnet: [],
  testnet: [],
  local: ["testnet"],
};

export interface ResolvedContractId {
  /** The resolved contract ID, or "" if none could be found. */
  contractId: string;
  /** The network that was originally requested. */
  requestedNetwork: NetworkName;
  /** Where the value actually came from: an override, a network, or nothing. */
  resolvedFrom: NetworkName | "override" | "none";
  /** True when the value came from a fallback network rather than the requested one. */
  usedFallback: boolean;
}

export class ContractRegistryLoader {
  constructor(
    private readonly registry: ContractRegistry,
    private readonly overrides: Partial<Record<ContractName, string | undefined>> = {},
  ) {}

  /**
   * Resolves a single contract's ID for the given network, applying
   * overrides first and the network fallback chain second.
   */
  resolve(name: ContractName, network: NetworkName): ResolvedContractId {
    const override = this.overrides[name];
    if (override && override.trim() !== "") {
      return {
        contractId: override,
        requestedNetwork: network,
        resolvedFrom: "override",
        usedFallback: false,
      };
    }

    const direct = this.registry[network]?.[name];
    if (direct && direct.trim() !== "") {
      return {
        contractId: direct,
        requestedNetwork: network,
        resolvedFrom: network,
        usedFallback: false,
      };
    }

    for (const fallbackNetwork of NETWORK_FALLBACK_ORDER[network]) {
      const fallbackId = this.registry[fallbackNetwork]?.[name];
      if (fallbackId && fallbackId.trim() !== "") {
        return {
          contractId: fallbackId,
          requestedNetwork: network,
          resolvedFrom: fallbackNetwork,
          usedFallback: true,
        };
      }
    }

    return {
      contractId: "",
      requestedNetwork: network,
      resolvedFrom: "none",
      usedFallback: false,
    };
  }

  /** Resolves every known contract name for the given network. */
  resolveAll(network: NetworkName): Record<ContractName, ResolvedContractId> {
    return Object.fromEntries(
      CONTRACT_NAMES.map((name) => [name, this.resolve(name, network)]),
    ) as Record<ContractName, ResolvedContractId>;
  }

  /**
   * Resolves a contract ID or throws a descriptive error, listing the
   * fallback networks that were attempted, when nothing could be found.
   */
  requireContractId(name: ContractName, network: NetworkName): string {
    const resolved = this.resolve(name, network);
    if (!resolved.contractId) {
      const fallbackChain = NETWORK_FALLBACK_ORDER[network];
      const attempted = [network, ...fallbackChain].join(" -> ");
      throw new Error(
        `Missing contract ID for "${name}" on network "${network}". ` +
          `Attempted lookup chain: ${attempted}. ` +
          `Provide an override or populate contracts/registry.json.`,
      );
    }
    return resolved.contractId;
  }
}

/** Convenience factory mirroring the constructor, for call-site readability. */
export function createContractRegistryLoader(
  registry: ContractRegistry,
  overrides: Partial<Record<ContractName, string | undefined>> = {},
): ContractRegistryLoader {
  return new ContractRegistryLoader(registry, overrides);
}
