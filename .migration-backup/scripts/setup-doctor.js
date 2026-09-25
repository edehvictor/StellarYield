#!/usr/bin/env node
/**
 * Contributor Setup Doctor  (Issue #966)
 *
 * Checks the local toolchain and workspace setup and prints concise,
 * actionable remediation for anything missing — so contributors find out
 * about a missing toolchain or env file immediately, instead of after a
 * confusing test/build failure.
 *
 * Checks:
 *   - Node.js and npm versions (blocking — nothing in this repo runs without them)
 *   - Rust, cargo, and the Stellar/Soroban CLI (recommended — only needed for contracts/ work)
 *   - `node_modules` present in each npm workspace (client, server, contracts,
 *     backend/keepers, backend/rewards, packages/sdk)
 *   - Each workspace's `.env.example` is present (blocking — its absence means
 *     the checkout itself is broken) and whether the real `.env`/`.env.local`
 *     derived from it exists yet (informational — normal before first setup)
 *
 * Usage: node scripts/setup-doctor.js
 * Exit code 0: no blocking issues. Exit code 1: at least one blocking issue.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const MIN_NODE_MAJOR = 20;
const MIN_NPM_MAJOR = 10;

const WORKSPACES = [
  { dir: "client", envExample: ".env.example", envFile: ".env.local" },
  { dir: "server", envExample: ".env.example", envFile: ".env" },
  { dir: "contracts", envExample: null, envFile: null },
  { dir: "backend/keepers", envExample: ".env.example", envFile: ".env" },
  { dir: "backend/rewards", envExample: null, envFile: null },
  { dir: "packages/sdk", envExample: null, envFile: null },
];

let blockingFailures = 0;

function absPath(...segments) {
  return path.join(ROOT, ...segments);
}

function tryCommand(command) {
  try {
    const out = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n")[0];
  } catch {
    return null;
  }
}

function printOk(label, detail) {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}

function printWarn(label, detail, remediation) {
  console.log(`  ⚠️  ${label}${detail ? ` — ${detail}` : ""}`);
  if (remediation) console.log(`     → ${remediation}`);
}

function printFail(label, detail, remediation) {
  blockingFailures += 1;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  if (remediation) console.log(`     → ${remediation}`);
}

// --- Toolchain checks --------------------------------------------------------

function checkNode() {
  const version = process.version; // e.g. "v20.11.0" — always available, no subprocess needed
  const major = parseInt(version.slice(1), 10);
  if (major >= MIN_NODE_MAJOR) {
    printOk("Node.js", version);
  } else {
    printFail(
      "Node.js",
      `${version} found, need ${MIN_NODE_MAJOR}+`,
      `Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org or via nvm: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`,
    );
  }
}

function checkNpm() {
  const version = tryCommand("npm --version");
  if (!version) {
    printFail("npm", "not found on PATH", "npm ships with Node.js — reinstall Node.js from https://nodejs.org");
    return;
  }
  const major = parseInt(version.split(".")[0], 10);
  if (major >= MIN_NPM_MAJOR) {
    printOk("npm", version);
  } else {
    printFail("npm", `${version} found, need ${MIN_NPM_MAJOR}+`, "Upgrade npm: npm install -g npm@latest");
  }
}

function checkRust() {
  const version = tryCommand("rustc --version");
  if (version) {
    printOk("Rust (rustc)", version);
  } else {
    printWarn(
      "Rust (rustc)",
      "not found on PATH",
      "Only required for contracts/ work. Install via rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
    );
  }
}

function checkCargo() {
  const version = tryCommand("cargo --version");
  if (version) {
    printOk("cargo", version);
  } else {
    printWarn(
      "cargo",
      "not found on PATH",
      "Only required for contracts/ work. Installed automatically alongside Rust via rustup: https://rustup.rs",
    );
  }
}

function checkSorobanCli() {
  const stellarVersion = tryCommand("stellar --version");
  if (stellarVersion) {
    printOk("Stellar CLI", stellarVersion);
    return;
  }
  const sorobanVersion = tryCommand("soroban --version");
  if (sorobanVersion) {
    printOk("Soroban CLI", sorobanVersion);
    return;
  }
  printWarn(
    "Stellar/Soroban CLI",
    "not found on PATH",
    "Only required for contract deployment/testing. Install: cargo install --locked stellar-cli",
  );
}

// --- Workspace checks --------------------------------------------------------

function checkWorkspaceInstalled(workspace) {
  const nodeModulesPath = absPath(workspace.dir, "node_modules");
  if (fs.existsSync(nodeModulesPath)) {
    printOk(`${workspace.dir}/node_modules`, "installed");
  } else {
    printWarn(
      `${workspace.dir}/node_modules`,
      "not installed",
      `cd ${workspace.dir} && npm ci`,
    );
  }
}

function checkWorkspaceEnv(workspace) {
  if (!workspace.envExample) return;

  const examplePath = absPath(workspace.dir, workspace.envExample);
  if (!fs.existsSync(examplePath)) {
    printFail(
      `${workspace.dir}/${workspace.envExample}`,
      "missing from the repository",
      "This file should be committed — re-clone the repository or run: git checkout -- " +
        path.join(workspace.dir, workspace.envExample),
    );
    return;
  }
  printOk(`${workspace.dir}/${workspace.envExample}`, "present");

  const envPath = absPath(workspace.dir, workspace.envFile);
  if (fs.existsSync(envPath)) {
    printOk(`${workspace.dir}/${workspace.envFile}`, "present");
  } else {
    printWarn(
      `${workspace.dir}/${workspace.envFile}`,
      "not created yet",
      `cp ${workspace.dir}/${workspace.envExample} ${workspace.dir}/${workspace.envFile} — then fill in your values (see docs/deployment-environment-matrix.md)`,
    );
  }
}

function main() {
  console.log("=== StellarYield Contributor Setup Doctor ===\n");

  console.log("Toolchain:");
  checkNode();
  checkNpm();
  checkRust();
  checkCargo();
  checkSorobanCli();

  console.log("\nWorkspace dependencies:");
  for (const workspace of WORKSPACES) {
    checkWorkspaceInstalled(workspace);
  }

  console.log("\nEnvironment files:");
  for (const workspace of WORKSPACES) {
    checkWorkspaceEnv(workspace);
  }

  console.log("");
  if (blockingFailures > 0) {
    console.log(
      `❌ ${blockingFailures} blocking issue${blockingFailures === 1 ? "" : "s"} found — fix the ❌ items above before running tests or the build.\n`,
    );
    process.exit(1);
  }

  console.log("✅ No blocking issues. Any ⚠️ items above are only needed for the areas you plan to work on.\n");
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkNode,
  checkNpm,
  checkRust,
  checkCargo,
  checkSorobanCli,
  checkWorkspaceInstalled,
  checkWorkspaceEnv,
  WORKSPACES,
};
