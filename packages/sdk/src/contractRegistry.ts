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
 *
 * When the registry is missing, malformed, or contains partial metadata the
 * loader falls back to a safe default record and records warnings so callers
 * can surface targeted messages without blocking contract views.
 */

import { validateNetworkName, type NetworkName } from "./network";
import {
  buildSdkFailureDiagnostics,
  redactDiagnosticText,
  type SdkDiagnostic,
  type SdkDiagnosticCode,
  type SdkStage,
} from "./diagnostics";

export type { NetworkName };

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

// ── Safe Fallback Registry ────────────────────────────────────────────────

/**
 * Deterministic fallback used when the primary registry is missing, unreadable,
 * or contains malformed data.  All addresses are empty strings so callers
 * receive a valid shape they can iterate over without crashing.
 */
const EMPTY_NETWORK: Partial<Record<ContractName, string>> =
  Object.fromEntries(CONTRACT_NAMES.map((n) => [n, ""])) as Partial<Record<ContractName, string>>;

const SAFE_FALLBACK_REGISTRY: ContractRegistry = {
  testnet: { ...EMPTY_NETWORK },
  mainnet: { ...EMPTY_NETWORK },
  local: { ...EMPTY_NETWORK },
};

/**
 * Validates whether the given value looks like a plausible `ContractRegistry`.
 * Returns the normalised value (merged over the safe fallback) on success, or
 * `null` when the value is irredeemably malformed.
 */
function normaliseRegistry(input: unknown): ContractRegistry | null {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const networks: NetworkName[] = ["testnet", "mainnet", "local"];
  const hasAnyNetwork = networks.some((n) => n in (input as Record<string, unknown>));
  if (!hasAnyNetwork) {
    return null;
  }

  const registry: ContractRegistry = {
    testnet: { ...EMPTY_NETWORK },
    mainnet: { ...EMPTY_NETWORK },
    local: { ...EMPTY_NETWORK },
  };

  for (const net of networks) {
    const netData = (input as Record<string, unknown>)[net];
    if (netData !== null && typeof netData === "object" && !Array.isArray(netData)) {
      registry[net] = { ...EMPTY_NETWORK, ...(netData as Partial<Record<ContractName, string>>) };
    }
  }

  return registry;
}

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

/**
 * Warnings surfaced by the loader when the registry data is incomplete or
 * fell back to safe defaults.
 */
export type RegistryWarningCode =
  | "fallback_used"
  | "partial_metadata"
  | "empty_registry"
  | "missing_contract";

export interface RegistryWarning {
  code: RegistryWarningCode;
  message: string;
  /** The network the warning pertains to (if applicable). */
  network?: NetworkName;
  /** The specific contract name (if applicable). */
  contract?: ContractName;
}

/**
 * Optional diagnostic context supplied when constructing or reloading a
 * contract registry loader.
 */
export interface ContractRegistryDiagnosticContext {
  /** Optional source label (e.g. 'bundled', 'remote'); redacted if sensitive. */
  source?: string;
  /** Optional correlation or request identifier. */
  correlationId?: string;
  /** Whether to attach a `STATE_PRESERVED` diagnostic on failure. Defaults to `true`. */
  preserveState?: boolean;
}

export interface ContractRegistryResolutionResult {
  ok: boolean;
  resolved: ResolvedContractId;
  diagnostics: SdkDiagnostic[];
}

export interface ContractRegistryReloadResult {
  ok: boolean;
  diagnostics: SdkDiagnostic[];
}

/**
 * Typed error thrown when contract registry resolution fails (e.g. missing
 * contract ID or insufficient diagnostic context). Carries privacy-safe
 * diagnostics identifying the failed stage, remediation path, and state
 * preservation guarantee.
 */
export class ContractRegistryError extends Error {
  readonly code: SdkDiagnosticCode;
  readonly stage: SdkStage = "contract-registry";
  readonly retryable: boolean;
  readonly statePreserved = true as const;
  readonly diagnostics: SdkDiagnostic[];
  readonly contract?: ContractName;
  readonly network?: NetworkName;

  constructor(
    message: string,
    options: {
      code?: SdkDiagnosticCode;
      retryable?: boolean;
      diagnostics: SdkDiagnostic[];
      contract?: ContractName;
      network?: NetworkName;
    },
  ) {
    super(redactDiagnosticText(message, "Contract registry resolution failed."));
    this.name = "ContractRegistryError";
    this.code = options.code ?? "CONTEXT_INSUFFICIENT";
    this.retryable = options.retryable ?? true;
    this.diagnostics = options.diagnostics;
    this.contract = options.contract;
    this.network = options.network;
  }
}

export class ContractRegistryLoader {
  private readonly _warnings: RegistryWarning[] = [];
  private readonly _diagnostics: SdkDiagnostic[] = [];
  private _usedFallback: boolean;
  private registry: ContractRegistry;

  constructor(
    registry: ContractRegistry,
    private readonly overrides: Partial<Record<ContractName, string | undefined>> = {},
    private readonly context?: ContractRegistryDiagnosticContext,
  ) {
    this.registry = registry;
    // Detect if the provided registry was replaced with safe defaults.
    this._usedFallback =
      this.registry === SAFE_FALLBACK_REGISTRY ||
      this.registry === (null as unknown as ContractRegistry);

    this.collectEmptyNetworkWarnings();
  }

  private collectEmptyNetworkWarnings(): void {
    // Check for partial metadata: any network where all contract addresses are empty.
    const networks: NetworkName[] = ["testnet", "mainnet", "local"];
    for (const net of networks) {
      const entries = Object.values(this.registry[net] ?? {});
      const hasAny = entries.some((v) => typeof v === "string" && v.trim() !== "");
      if (!hasAny) {
        this._warnings.push({
          code: "empty_registry",
          message: `Network "${net}" has no contract addresses in the registry`,
          network: net,
        });
      }
    }
  }

  /**
   * Create a loader with the safe fallback registry and an optional warning.
   * Any raw reason string is redacted so sensitive paths, URLs, or secrets are
   * never exposed in warnings or diagnostics.
   */
  static withFallback(
    reason?: string,
    overrides?: Partial<Record<ContractName, string | undefined>>,
    context?: ContractRegistryDiagnosticContext,
  ): ContractRegistryLoader {
    const loader = new ContractRegistryLoader(SAFE_FALLBACK_REGISTRY, overrides, context);
    const safeReason =
      typeof reason === "string" && reason.trim().length > 0
        ? redactDiagnosticText(reason, "Contract registry lacked sufficient diagnostic context.")
        : "Contract registry lacked sufficient diagnostic context.";

    loader._warnings.unshift({
      code: "fallback_used",
      message: safeReason,
    });

    loader._diagnostics.push(
      ...buildSdkFailureDiagnostics("CONTEXT_INSUFFICIENT", {
        stage: "contract-registry",
        summary: `Contract registry fell back to safe defaults: ${safeReason}`,
        remediation:
          "Provide a valid contract registry or explicit contract overrides and retry; existing state and balances were preserved.",
        retryable: true,
        preserveState: context?.preserveState ?? true,
      }),
    );

    return loader;
  }

  /** Warnings accumulated during construction / resolution. */
  get warnings(): RegistryWarning[] {
    return [...this._warnings];
  }

  /** Privacy-safe diagnostics accumulated during construction / reload. */
  get diagnostics(): SdkDiagnostic[] {
    return [...this._diagnostics];
  }

  /** Whether the loader is operating on the safe fallback registry. */
  get usedFallback(): boolean {
    return this._usedFallback;
  }

  /**
   * Safely reloads the underlying contract registry.
   *
   * When the incoming registry is `null`, `undefined`, or malformed, the
   * existing registry state is preserved unchanged and privacy-safe
   * `CONTEXT_INSUFFICIENT` + `STATE_PRESERVED` diagnostics are returned so
   * callers can retry safely once valid data is available.
   */
  reload(
    registry: ContractRegistry | null | undefined,
    context?: ContractRegistryDiagnosticContext,
  ): ContractRegistryReloadResult {
    const effectiveContext = context ?? this.context;

    if (registry === null || registry === undefined) {
      const diagnostics = buildSdkFailureDiagnostics("CONTEXT_INSUFFICIENT", {
        stage: "contract-registry",
        summary:
          "Contract registry reload received null or undefined input; insufficient context to update registry.",
        remediation:
          "Supply a valid contract registry object and retry; existing registry state and balances were preserved.",
        retryable: true,
        preserveState: effectiveContext?.preserveState ?? true,
      });
      this._diagnostics.push(...diagnostics);
      return { ok: false, diagnostics };
    }

    const normalised = normaliseRegistry(registry);
    if (normalised === null) {
      const diagnostics = buildSdkFailureDiagnostics("CONTEXT_INSUFFICIENT", {
        stage: "contract-registry",
        summary:
          "Contract registry reload received an invalid or incomplete structure; insufficient context to update registry.",
        remediation:
          "Provide a registry containing at least one supported network mapping and retry; existing registry state and balances were preserved.",
        retryable: true,
        preserveState: effectiveContext?.preserveState ?? true,
      });
      this._diagnostics.push(...diagnostics);
      return { ok: false, diagnostics };
    }

    this.registry = normalised;
    this._usedFallback = false;
    this._warnings.length = 0;
    this.collectEmptyNetworkWarnings();
    return { ok: true, diagnostics: [] };
  }

  /**
   * Resolves a single contract's ID for the given network, applying
   * overrides first and the network fallback chain second.
   *
   * Validates `network` against {@link SUPPORTED_NETWORKS} first (#1109) and
   * throws {@link UnsupportedNetworkError} for anything else — callers that
   * received a network id from outside the type system (env vars, a wallet
   * adapter, user input) get a clear, typed failure here rather than a
   * silent empty-registry lookup.
   */
  resolve(name: ContractName, network: NetworkName): ResolvedContractId {
    validateNetworkName(network);
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

  /**
   * Resolves a contract ID and returns privacy-safe diagnostics when the
   * contract cannot be resolved, without mutating existing state.
   */
  resolveWithDiagnostics(
    name: ContractName,
    network: NetworkName,
  ): ContractRegistryResolutionResult {
    const resolved = this.resolve(name, network);
    if (resolved.contractId) {
      return { ok: true, resolved, diagnostics: [] };
    }

    const fallbackChain = NETWORK_FALLBACK_ORDER[network];
    const attempted = [network, ...fallbackChain].join(" -> ");
    const diagnostics = buildSdkFailureDiagnostics("CONTEXT_INSUFFICIENT", {
      stage: "contract-registry",
      summary: `Contract "${name}" could not be resolved for network "${network}" (attempted: ${attempted}).`,
      remediation:
        "Provide an explicit contract override or populate the contract registry and retry; existing state and balances were preserved.",
      retryable: true,
      preserveState: this.context?.preserveState ?? true,
    });

    return { ok: false, resolved, diagnostics };
  }

  /** Resolves every known contract name for the given network. */
  resolveAll(network: NetworkName): Record<ContractName, ResolvedContractId> {
    return Object.fromEntries(
      CONTRACT_NAMES.map((name) => [name, this.resolve(name, network)]),
    ) as Record<ContractName, ResolvedContractId>;
  }

  /**
   * Resolves a contract ID or throws a typed {@link ContractRegistryError}
   * carrying privacy-safe diagnostics, listing the fallback networks that were
   * attempted, when nothing could be found.
   */
  requireContractId(name: ContractName, network: NetworkName): string {
    const result = this.resolveWithDiagnostics(name, network);
    if (!result.ok) {
      const fallbackChain = NETWORK_FALLBACK_ORDER[network];
      const attempted = [network, ...fallbackChain].join(" -> ");
      throw new ContractRegistryError(
        `Missing contract ID for "${name}" on network "${network}". ` +
          `Attempted lookup chain: ${attempted}. ` +
          `Provide an override or populate contracts/registry.json.`,
        {
          code: "CONTEXT_INSUFFICIENT",
          retryable: true,
          diagnostics: result.diagnostics,
          contract: name,
          network,
        },
      );
    }
    return result.resolved.contractId;
  }
}

/**
 * Convenience factory.  When `registry` is `null`, `undefined`, or
 * irredeemably malformed, the loader automatically falls back to safe
 * defaults and records privacy-safe warnings and diagnostics.
 */
export function createContractRegistryLoader(
  registry: ContractRegistry | null | undefined,
  overrides: Partial<Record<ContractName, string | undefined>> = {},
  context?: ContractRegistryDiagnosticContext,
): ContractRegistryLoader {
  if (registry === null || registry === undefined) {
    return ContractRegistryLoader.withFallback(
      "Registry was null or undefined",
      overrides,
      context,
    );
  }

  const normalised = normaliseRegistry(registry);
  if (normalised === null) {
    return ContractRegistryLoader.withFallback(
      "Registry has an invalid structure",
      overrides,
      context,
    );
  }

  return new ContractRegistryLoader(normalised, overrides, context);
}
