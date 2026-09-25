#!/usr/bin/env node
/**
 * generate-manifest.js
 *
 * Generates a deployment manifest after a contract deployment run.
 * The manifest captures contract IDs plus a structured provenance block with
 * network details, source input hashes, git metadata, and CI context so that
 * deployments are fully traceable.
 *
 * Usage:
 *   node contracts/scripts/generate-manifest.js [--input <deployed.json>] \
 *       [--network <testnet|mainnet|local>] \
 *       [--output <path>]
 *
 * Options:
 *   --input   Path to the deployed.json produced by deploy.sh
 *             (default: contracts/scripts/deployed.json)
 *   --network Stellar network name: testnet | mainnet | local
 *             (default: testnet)
 *   --output  Where to write the manifest JSON
 *             (default: contracts/scripts/deployment-manifest.json)
 *   --rpc-url Network RPC URL recorded in provenance
 *             (default: STELLAR_RPC_URL or "unknown")
 *   --network-passphrase Network passphrase recorded in provenance
 *             (default: STELLAR_NETWORK_PASSPHRASE or "unknown")
 *
 * Example:
 *   node contracts/scripts/generate-manifest.js \
 *       --input contracts/scripts/deployed.json \
 *       --network testnet \
 *       --output contracts/scripts/deployment-manifest.json
 *
 * Sample output:
 *   See contracts/scripts/deployment-manifest.example.json
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Soroban contract ID validation
// Contract IDs are 56-character base32 strings starting with 'C'.
// Stellar public keys start with 'G'. Both are valid contract identifiers.
// ---------------------------------------------------------------------------
const CONTRACT_ID_RE = /^[CG][A-Z2-7]{55}$/;

function isValidContractId(value) {
  return typeof value === "string" && CONTRACT_ID_RE.test(value);
}

const ALLOWED_NETWORKS = new Set(["testnet", "mainnet", "local"]);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getGitCommitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function getGitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function getGitRemoteUrl() {
  try {
    return execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function getFileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizePathForManifest(filePath) {
  const repoRoot = path.resolve(__dirname, "../..");
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(repoRoot, absolutePath);

  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }

  return absolutePath;
}

function detectCiProvider() {
  if (process.env.GITHUB_ACTIONS === "true") return "github-actions";
  if (process.env.CI) return "ci";
  return "local";
}

function buildProvenance({
  generatedAt,
  inputPath,
  registryPath,
  registryExists,
  network,
  rpcUrl,
  networkPassphrase,
  commitSha,
  branch,
}) {
  return {
    generatedBy: "contracts/scripts/generate-manifest.js",
    generatedAt,
    sourceInput: {
      path: normalizePathForManifest(inputPath),
      sha256: getFileSha256(inputPath),
    },
    registryInput: {
      path: normalizePathForManifest(registryPath),
      sha256: registryExists ? getFileSha256(registryPath) : null,
    },
    network: {
      name: network,
      rpcUrl: rpcUrl || "unknown",
      passphrase: networkPassphrase || "unknown",
    },
    git: {
      commitSha,
      branch,
      remoteUrl: getGitRemoteUrl(),
    },
    ci: {
      provider: detectCiProvider(),
      runId: process.env.GITHUB_RUN_ID || process.env.CI_PIPELINE_ID || "local",
      workflow: process.env.GITHUB_WORKFLOW || "local",
      actor: process.env.GITHUB_ACTOR || process.env.USER || process.env.USERNAME || "unknown",
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const SCRIPTS_DIR = path.join(__dirname);
  const CONTRACTS_DIR = path.join(SCRIPTS_DIR, "..");

  const args = parseArgs(process.argv);

  const inputPath = args.input ?? path.join(SCRIPTS_DIR, "deployed.json");
  const network = args.network ?? "testnet";
  const outputPath = args.output ?? path.join(SCRIPTS_DIR, "deployment-manifest.json");
  const rpcUrl = args["rpc-url"] ?? process.env.STELLAR_RPC_URL ?? "unknown";
  const networkPassphrase = args["network-passphrase"] ?? process.env.STELLAR_NETWORK_PASSPHRASE ?? "unknown";

  // Validate network
  if (!ALLOWED_NETWORKS.has(network)) {
    console.error(
      `ERROR: --network must be one of: ${[...ALLOWED_NETWORKS].join(", ")}. Got: "${network}"`
    );
    process.exit(1);
  }

  // Read deployed.json
  if (!fs.existsSync(inputPath)) {
    console.error(`ERROR: Input file not found: ${inputPath}`);
    console.error(
      "Run deploy.sh first, or pass --input <path> to specify the deployed.json location."
    );
    process.exit(1);
  }

  let deployedContracts;
  try {
    const raw = fs.readFileSync(inputPath, "utf8");
    deployedContracts = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: Failed to parse ${inputPath}: ${err.message}`);
    process.exit(1);
  }

  if (typeof deployedContracts !== "object" || deployedContracts === null || Array.isArray(deployedContracts)) {
    console.error("ERROR: deployed.json must be a JSON object mapping contract names to IDs.");
    process.exit(1);
  }

  // Validate each contract ID
  const validContracts = {};
  const invalidEntries = [];

  for (const [name, contractId] of Object.entries(deployedContracts)) {
    if (!contractId || contractId === "") {
      // Empty string — contract was not deployed in this run; skip silently.
      continue;
    }
    if (!isValidContractId(contractId)) {
      invalidEntries.push({ name, contractId });
    } else {
      validContracts[name] = contractId;
    }
  }

  if (invalidEntries.length > 0) {
    console.error("ERROR: The following contract IDs are invalid (must be 56-char base32 starting with C or G):");
    for (const { name, contractId } of invalidEntries) {
      console.error(`  ${name}: "${contractId}"`);
    }
    process.exit(1);
  }

  if (Object.keys(validContracts).length === 0) {
    console.warn("WARNING: No deployed contract IDs found in the input file. Manifest will have an empty contracts map.");
  }

  // Read registry.json to cross-reference (best-effort)
  let registryNote = null;
  const registryPath = path.join(CONTRACTS_DIR, "registry.json");
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      const networkContracts = registry[network] ?? {};
      const missingInRegistry = Object.keys(validContracts).filter(
        (name) => !networkContracts[name]
      );
      if (missingInRegistry.length > 0) {
        registryNote = `The following deployed contracts are not yet in registry.json[${network}]: ${missingInRegistry.join(", ")}. Run deploy.sh to update the registry automatically.`;
        console.warn(`WARNING: ${registryNote}`);
      }
    } catch {
      // Non-fatal — just skip registry cross-reference.
    }
  }

  // Build manifest
  const generatedAt = new Date().toISOString();
  const commitSha = getGitCommitSha();
  const branch = getGitBranch();
  const provenance = buildProvenance({
    generatedAt,
    inputPath,
    registryPath,
    registryExists: fs.existsSync(registryPath),
    network,
    rpcUrl,
    networkPassphrase,
    commitSha,
    branch,
  });

  const manifest = {
    schemaVersion: "1.0",
    generatedAt,
    network,
    commitSha,
    branch,
    provenance,
    contracts: validContracts,
    ...(registryNote ? { registryNote } : {}),
  };

  // Write output
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Deployment manifest written to: ${outputPath}`);
  console.log(`  Network:    ${manifest.network}`);
  console.log(`  Commit:     ${manifest.commitSha}`);
  console.log(`  Branch:     ${manifest.branch}`);
  console.log(`  Source:     ${manifest.provenance.sourceInput.path} (${manifest.provenance.sourceInput.sha256})`);
  console.log(`  Registry:   ${manifest.provenance.registryInput.path} (${manifest.provenance.registryInput.sha256 ?? "not found"})`);
  console.log(`  Contracts:  ${Object.keys(manifest.contracts).join(", ") || "(none)"}`);
}

main();
