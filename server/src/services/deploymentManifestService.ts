/**
 * Deployment manifest verification service (#1296).
 *
 * Deterministic, read-only verification of the contract deployment manifest
 * (contracts/scripts/deployment-manifest.json) and its alignment with the
 * contract registry (contracts/registry.json via contractRegistry.ts).
 *
 * The verification mirrors the contract-side `verify-manifest.js` pipeline
 * (provenance → schema conformance → drift) but is typed and returns a
 * structured envelope the client can render directly. No wall-clock timestamp
 * is embedded in the result; identical inputs produce identical outputs.
 */

import * as path from "path";
import * as fs from "fs";
import { getAllContractIds, type NetworkName } from "./contractRegistry";

const ALLOWED_NETWORKS: NetworkName[] = ["testnet", "mainnet", "local"];

const MANIFEST_PATH = path.resolve(
  __dirname,
  "../../../../contracts/scripts/deployment-manifest.json",
);

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../../contracts/scripts/manifest-schema.json",
);

const CONTRACT_ID_RE = /^[CG][A-Z2-7]{55}$/;

export const MANIFEST_TO_REGISTRY_ALIAS: Record<string, string> = {
  yield_vault: "vault",
  optimistic_governance: "governance",
  strategies: "strategy",
  emission_controller: "emissionController",
  liquid_staking: "liquidStaking",
};

export type DeploymentContractStatus =
  | "MATCH"
  | "MISSING"
  | "MISMATCH"
  | "STALE"
  | "SKIPPED";

export type DeploymentManifestIssueCode =
  | "MANIFEST_MALFORMED"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "PROVENANCE_INVALID"
  | "CONTRACT_ID_INVALID"
  | "DRIFT";

export interface DeploymentManifestIssue {
  code: DeploymentManifestIssueCode;
  message: string;
}

export interface DeploymentContractEntry {
  name: string;
  manifestAddress: string;
  registryAddress: string;
  status: DeploymentContractStatus;
}

export type DeploymentManifestOverallStatus =
  | "verified"
  | "pending_generation"
  | "invalid"
  | "drift";

export interface DeploymentManifestVerification {
  network: NetworkName;
  manifestPath: string;
  registrySource: string;
  schemaPath: string;
  status: DeploymentManifestOverallStatus;
  schemaVersion: string | null;
  issues: DeploymentManifestIssue[];
  contracts: DeploymentContractEntry[];
}

export class DeploymentManifestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DeploymentManifestError";
  }
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function toRegistryAlias(manifestKey: string): string {
  return MANIFEST_TO_REGISTRY_ALIAS[manifestKey] ?? manifestKey;
}

function qualifiedNetwork(network: unknown): NetworkName {
  const value = String(network ?? "testnet").toLowerCase();
  if (!ALLOWED_NETWORKS.includes(value as NetworkName)) {
    throw new DeploymentManifestError(
      "INVALID_NETWORK",
      `network must be one of: ${ALLOWED_NETWORKS.join(", ")}.`,
      400,
      { received: network },
    );
  }
  return value as NetworkName;
}

export interface DeploymentManifestVerificationOptions {
  /** Override the manifest path (defaults to contracts/scripts/deployment-manifest.json). */
  manifestPath?: string;
  /** Override the registry map (defaults to the repo registry for the network). */
  registry?: Record<string, string>;
}

/**
 * Build the deterministic verification result for the deployment manifest on a
 * network. Status ladder:
 *   - manifest absent                       → "pending_generation"
 *   - malformed/version/provenance/ID issue → "invalid"
 *   - any drift issue                       → "drift"
 *   - otherwise                             → "verified"
 */
export function buildDeploymentManifestVerification(
  network?: NetworkName,
  options: DeploymentManifestVerificationOptions = {},
): DeploymentManifestVerification {
  const activeNetwork = qualifiedNetwork(network);
  const manifestPath = options.manifestPath ?? MANIFEST_PATH;

  if (!fs.existsSync(manifestPath)) {
    return {
      network: activeNetwork,
      manifestPath,
      registrySource: "contracts/registry.json",
      schemaPath: SCHEMA_PATH,
      status: "pending_generation",
      schemaVersion: null,
      issues: [
        {
          code: "MANIFEST_MALFORMED",
          message: `No deployment manifest found at ${manifestPath}. Run contracts/scripts/generate-manifest.js after the next deploy.`,
        },
      ],
      contracts: [],
    };
  }

  let manifest: {
    schemaVersion?: unknown;
    generatedAt?: unknown;
    network?: unknown;
    provenance?: Record<string, unknown>;
    contracts?: Record<string, string>;
  };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return {
      network: activeNetwork,
      manifestPath,
      registrySource: "contracts/registry.json",
      schemaPath: SCHEMA_PATH,
      status: "invalid",
      schemaVersion: null,
      issues: [
        {
          code: "MANIFEST_MALFORMED",
          message: `Failed to parse manifest: ${(err as Error).message}`,
        },
      ],
      contracts: [],
    };
  }

  const issues: DeploymentManifestIssue[] = [];
  const rawContracts = manifest.contracts ?? {};

  const schemaVersion =
    typeof manifest.schemaVersion === "string" ? manifest.schemaVersion : null;
  if (schemaVersion !== "1.0") {
    issues.push({
      code: "SCHEMA_VERSION_UNSUPPORTED",
      message: `schemaVersion "${schemaVersion ?? "missing"}" is not supported; expected "1.0".`,
    });
  }

  const provenance = manifest.provenance;
  if (!provenance || typeof provenance !== "object") {
    issues.push({
      code: "PROVENANCE_INVALID",
      message: "manifest.provenance is missing or not an object.",
    });
  } else {
    const provenanceErrors: string[] = [];
    const generatedBy = provenance.generatedBy;
    const generatedAt = provenance.generatedAt;
    const networkMeta = provenance.network;

    if (typeof generatedBy !== "string" || generatedBy.trim().length === 0) {
      provenanceErrors.push("manifest.provenance.generatedBy must be a non-empty string.");
    }
    if (!isIsoTimestamp(generatedAt)) {
      provenanceErrors.push("manifest.provenance.generatedAt must be an ISO-8601 UTC timestamp.");
    } else if (manifest.generatedAt !== generatedAt) {
      provenanceErrors.push("manifest.provenance.generatedAt must match manifest.generatedAt.");
    }
    if (!networkMeta || typeof networkMeta !== "object") {
      provenanceErrors.push("manifest.provenance.network must be an object.");
    } else {
      const networkName = (networkMeta as Record<string, unknown>).name;
      if (networkName !== activeNetwork) {
        provenanceErrors.push(
          `manifest.provenance.network.name must match the verified network (${activeNetwork}).`,
        );
      }
      if (manifest.network !== networkName) {
        provenanceErrors.push("manifest.provenance.network.name must match manifest.network.");
      }
    }

    if (provenanceErrors.length > 0) {
      issues.push({
        code: "PROVENANCE_INVALID",
        message: provenanceErrors.join(" "),
      });
    }
  }

  const registryAll = options.registry ?? getAllContractIds(activeNetwork);
  const registryEntries = Object.entries(registryAll).filter(([, addr]) => addr && addr.length > 0);
  const registryByAlias = new Map(registryEntries);

  const contractEntries: DeploymentContractEntry[] = Object.keys(rawContracts)
    .sort()
    .map((name) => {
      const manifestAddress = rawContracts[name];
      const registryAlias = toRegistryAlias(name);
      const registryAddress = registryByAlias.get(registryAlias) ?? "";

      if (!manifestAddress || manifestAddress.length === 0) {
        return {
          name,
          manifestAddress,
          registryAddress,
          status: "SKIPPED" as const,
        };
      }

      if (!CONTRACT_ID_RE.test(manifestAddress)) {
        issues.push({
          code: "CONTRACT_ID_INVALID",
          message: `contract "${name}" has an invalid Soroban ID "${manifestAddress}".`,
        });
        return {
          name,
          manifestAddress,
          registryAddress,
          status: "SKIPPED" as const,
        };
      }

      let status: DeploymentContractStatus;
      if (registryAddress && registryAddress === manifestAddress) {
        status = "MATCH";
      } else if (registryAddress && registryAddress !== manifestAddress) {
        status = "MISMATCH";
        issues.push({
          code: "DRIFT",
          message: `contract "${name}": registry has ${registryAddress} but manifest has ${manifestAddress}.`,
        });
      } else {
        status = "STALE";
        issues.push({
          code: "DRIFT",
          message: `contract "${name}": manifest has ${manifestAddress} but registry has no non-empty address for "${registryAlias}".`,
        });
      }

      return { name, manifestAddress, registryAddress, status };
    });

  // MISSING — registry has a non-empty address with no matching manifest entry.
  for (const [alias, address] of registryEntries) {
    const manifestKey = Object.keys(MANIFEST_TO_REGISTRY_ALIAS).find(
      (m) => MANIFEST_TO_REGISTRY_ALIAS[m] === alias,
    );
    if (manifestKey) {
      const present = contractEntries.some(
        (c) => toRegistryAlias(c.name) === alias && Boolean(c.manifestAddress),
      );
      if (!present) {
        contractEntries.push({
          name: manifestKey,
          manifestAddress: "",
          registryAddress: address,
          status: "MISSING",
        });
        issues.push({
          code: "DRIFT",
          message: `contract "${manifestKey}": registry has ${address} but manifest has no entry.`,
        });
      }
    }
  }

  contractEntries.sort((a, b) => a.name.localeCompare(b.name));
  const contracts = contractEntries;

  const hasInvalid = issues.some(
    (i) =>
      i.code === "MANIFEST_MALFORMED" ||
      i.code === "SCHEMA_VERSION_UNSUPPORTED" ||
      i.code === "PROVENANCE_INVALID" ||
      i.code === "CONTRACT_ID_INVALID",
  );
  const hasDrift = issues.some((i) => i.code === "DRIFT");

  const status: DeploymentManifestOverallStatus = hasInvalid
    ? "invalid"
    : hasDrift
      ? "drift"
      : "verified";

  return {
    network: activeNetwork,
    manifestPath,
    registrySource: "contracts/registry.json",
    schemaPath: SCHEMA_PATH,
    status,
    schemaVersion,
    issues,
    contracts,
  };
}