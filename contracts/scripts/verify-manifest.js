#!/usr/bin/env node
/**
 * verify-manifest.js
 *
 * Validates deployment manifest provenance and compares the manifest
 * (deployment-manifest.json) against the contract registry (registry.json) for
 * a given network, reporting drift.
 *
 * Three drift types are detected:
 *   MISSING  — registry has a non-empty address but the manifest has no entry
 *   MISMATCH — both have an entry for the alias but the addresses differ
 *   STALE    — manifest has an entry that has no corresponding registry alias,
 *              or the registry address is empty (manifest is out of date)
 *
 * Usage:
 *   node contracts/scripts/verify-manifest.js \
 *       --manifest contracts/scripts/deployment-manifest.json \
 *       --registry contracts/registry.json \
 *       --network testnet
 *
 * Options:
 *   --manifest  Path to deployment-manifest.json (required).
 *               If the file does not exist the script exits 0 (no deployment
 *               has been recorded yet — that is not an error in CI).
 *   --registry  Path to registry.json
 *               (default: contracts/registry.json relative to this script)
 *   --network   Network name: testnet | mainnet | local
 *               (default: taken from manifest.network)
 *
 * Exit codes:
 *   0 — manifest absent (skip) or all entries agree
 *   1 — malformed provenance or one or more drift issues found
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Name mapping: deploy name (in manifest) → registry alias (in registry.json)
// Mirrors the REGISTRY_KEY_MAP in deploy.sh.
// ---------------------------------------------------------------------------
const MANIFEST_TO_REGISTRY = {
  yield_vault: "vault",
  strategies: "strategy",
  optimistic_governance: "governance",
  emission_controller: "emissionController",
  liquid_staking: "liquidStaking",
};

// Inverted map: registry alias → manifest deploy name
const REGISTRY_TO_MANIFEST = Object.fromEntries(
  Object.entries(MANIFEST_TO_REGISTRY).map(([m, r]) => [r, m])
);


const ALLOWED_NETWORKS = new Set(["testnet", "mainnet", "local"]);
const SHA256_RE = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateSha256(value) {
  return isNonEmptyString(value) && SHA256_RE.test(value);
}

function validateProvenance(manifest, selectedNetwork) {
  const errors = [];
  const provenance = manifest.provenance;

  if (!isPlainObject(provenance)) {
    return ["manifest.provenance is missing or not an object."];
  }

  if (!isNonEmptyString(provenance.generatedBy)) {
    errors.push("manifest.provenance.generatedBy must be a non-empty string.");
  }

  if (!isIsoTimestamp(provenance.generatedAt)) {
    errors.push("manifest.provenance.generatedAt must be an ISO-8601 UTC timestamp.");
  } else if (manifest.generatedAt !== provenance.generatedAt) {
    errors.push("manifest.provenance.generatedAt must match manifest.generatedAt.");
  }

  if (!isPlainObject(provenance.sourceInput)) {
    errors.push("manifest.provenance.sourceInput must be an object.");
  } else {
    if (!isNonEmptyString(provenance.sourceInput.path)) {
      errors.push("manifest.provenance.sourceInput.path must be a non-empty string.");
    }
    if (!validateSha256(provenance.sourceInput.sha256)) {
      errors.push("manifest.provenance.sourceInput.sha256 must be a 64-character lowercase hex SHA-256 digest.");
    }
  }

  if (!isPlainObject(provenance.registryInput)) {
    errors.push("manifest.provenance.registryInput must be an object.");
  } else {
    if (!isNonEmptyString(provenance.registryInput.path)) {
      errors.push("manifest.provenance.registryInput.path must be a non-empty string.");
    }
    if (provenance.registryInput.sha256 !== null && !validateSha256(provenance.registryInput.sha256)) {
      errors.push("manifest.provenance.registryInput.sha256 must be null or a 64-character lowercase hex SHA-256 digest.");
    }
  }

  if (!isPlainObject(provenance.network)) {
    errors.push("manifest.provenance.network must be an object.");
  } else {
    if (!ALLOWED_NETWORKS.has(provenance.network.name)) {
      errors.push(`manifest.provenance.network.name must be one of: ${[...ALLOWED_NETWORKS].join(", ")}.`);
    } else if (provenance.network.name !== selectedNetwork) {
      errors.push(`manifest.provenance.network.name (${provenance.network.name}) must match the verified network (${selectedNetwork}).`);
    }
    if (manifest.network !== provenance.network.name) {
      errors.push("manifest.provenance.network.name must match manifest.network.");
    }
    if (!isNonEmptyString(provenance.network.rpcUrl)) {
      errors.push("manifest.provenance.network.rpcUrl must be a non-empty string.");
    }
    if (!isNonEmptyString(provenance.network.passphrase)) {
      errors.push("manifest.provenance.network.passphrase must be a non-empty string.");
    }
  }

  if (!isPlainObject(provenance.git)) {
    errors.push("manifest.provenance.git must be an object.");
  } else {
    for (const field of ["commitSha", "branch", "remoteUrl"]) {
      if (!isNonEmptyString(provenance.git[field])) {
        errors.push(`manifest.provenance.git.${field} must be a non-empty string.`);
      }
    }
    if (isNonEmptyString(manifest.commitSha) && provenance.git.commitSha !== manifest.commitSha) {
      errors.push("manifest.provenance.git.commitSha must match manifest.commitSha.");
    }
    if (isNonEmptyString(manifest.branch) && provenance.git.branch !== manifest.branch) {
      errors.push("manifest.provenance.git.branch must match manifest.branch.");
    }
  }

  if (!isPlainObject(provenance.ci)) {
    errors.push("manifest.provenance.ci must be an object.");
  } else {
    for (const field of ["provider", "runId", "workflow", "actor"]) {
      if (!isNonEmptyString(provenance.ci[field])) {
        errors.push(`manifest.provenance.ci.${field} must be a non-empty string.`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);

  if (!args.manifest) {
    console.error("ERROR: --manifest <path> is required.");
    process.exit(1);
  }

  const defaultRegistryPath = path.join(__dirname, "../registry.json");
  const registryPath = args.registry ?? defaultRegistryPath;

  // Graceful skip when manifest is absent (typical on branches without a deployment).
  if (!fs.existsSync(args.manifest)) {
    console.log("No deployment manifest found — skipping verification.");
    process.exit(0);
  }

  // Load manifest
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  } catch (err) {
    console.error(`ERROR: Failed to parse manifest at ${args.manifest}: ${err.message}`);
    process.exit(1);
  }

  if (!manifest.contracts || typeof manifest.contracts !== "object") {
    console.error("ERROR: manifest.contracts is missing or not an object.");
    process.exit(1);
  }

  const network = args.network ?? manifest.network;
  if (!network) {
    console.error("ERROR: --network is required (or manifest.network must be set).");
    process.exit(1);
  }

  const provenanceErrors = validateProvenance(manifest, network);
  if (provenanceErrors.length > 0) {
    console.error("ERROR: manifest provenance metadata is missing or malformed:");
    for (const error of provenanceErrors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  // Load registry
  if (!fs.existsSync(registryPath)) {
    console.error(`ERROR: registry.json not found at ${registryPath}`);
    process.exit(1);
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (err) {
    console.error(`ERROR: Failed to parse registry at ${registryPath}: ${err.message}`);
    process.exit(1);
  }

  const networkContracts = registry[network];
  if (!networkContracts || typeof networkContracts !== "object") {
    console.error(`ERROR: registry.json has no entry for network "${network}".`);
    process.exit(1);
  }

  console.log(`--- Verifying deployment manifest against registry [${network}] ---`);
  console.log(`  Manifest:  ${args.manifest}`);
  console.log(`  Registry:  ${registryPath}`);
  console.log();

  const issues = [];

  // 1. For each registry alias with a non-empty address, check the manifest.
  for (const [alias, registryAddr] of Object.entries(networkContracts)) {
    if (!registryAddr) continue; // empty registry entry — contract not yet deployed

    const manifestKey = REGISTRY_TO_MANIFEST[alias] ?? alias;
    const manifestAddr = manifest.contracts[manifestKey];

    if (!manifestAddr) {
      issues.push({
        type: "MISSING",
        label: alias,
        detail: `registry: ${registryAddr} | manifest: not found (looked for key "${manifestKey}")`,
      });
    } else if (manifestAddr !== registryAddr) {
      issues.push({
        type: "MISMATCH",
        label: alias,
        detail: `registry: ${registryAddr} | manifest: ${manifestAddr}`,
      });
    }
  }

  // 2. For each manifest entry, check the registry has a matching non-empty address.
  for (const [manifestKey, manifestAddr] of Object.entries(manifest.contracts)) {
    if (!manifestAddr) continue;

    const registryAlias = MANIFEST_TO_REGISTRY[manifestKey] ?? manifestKey;
    const registryAddr = networkContracts[registryAlias];

    if (!registryAddr) {
      // Only report STALE if we didn't already flag a MISMATCH for this alias above.
      const alreadyReported = issues.some(
        (i) => (i.type === "MISSING" || i.type === "MISMATCH") && i.label === registryAlias
      );
      if (!alreadyReported) {
        issues.push({
          type: "STALE",
          label: manifestKey,
          detail: `manifest: ${manifestAddr} | registry["${registryAlias}"]: ${registryAddr === undefined ? "not found" : "empty"}`,
        });
      }
    }
  }

  // Output
  if (issues.length === 0) {
    console.log("Result: PASSED — manifest and registry agree.");
    process.exit(0);
  }

  const WIDTH = 8; // pad type column
  for (const issue of issues) {
    console.log(`${issue.type.padEnd(WIDTH)} ${issue.label}`);
    console.log(`         (${issue.detail})`);
  }

  console.log();
  console.log(`Result: FAILED (${issues.length} issue(s))`);
  process.exit(1);
}

main();
