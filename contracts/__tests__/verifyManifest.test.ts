import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Tests for verify-manifest.js
 *
 * Each test exercises the script as a child process with temp fixture files
 * so we can assert on exit codes and stdout/stderr without importing the CJS
 * module directly.
 */

const SCRIPT = path.resolve(__dirname, "../scripts/verify-manifest.js");

// Valid 56-char Soroban contract IDs (starts with C, base32)
const ID_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ID_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";
const ID_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCSC4";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verify-manifest-test-"));
}

const VALID_SHA = "a".repeat(64);

function validProvenance(overrides: Record<string, unknown> = {}) {
  const generatedAt = "2026-05-28T12:00:00.000Z";
  return {
    generatedAt,
    provenance: {
      generatedBy: "contracts/scripts/generate-manifest.js",
      generatedAt,
      sourceInput: { path: "contracts/scripts/deployed.json", sha256: VALID_SHA },
      registryInput: { path: "contracts/registry.json", sha256: VALID_SHA },
      network: { name: "testnet", rpcUrl: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
      git: { commitSha: "abc123", branch: "main", remoteUrl: "https://github.com/Kappa16/StellarYield.git" },
      ci: { provider: "local", runId: "local", workflow: "local", actor: "test" },
    },
    ...overrides,
  };
}

function writeManifest(dir: string, data: object): string {
  const p = path.join(dir, "deployment-manifest.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

function writeRegistry(dir: string, data: object): string {
  const p = path.join(dir, "registry.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

function runScript(scriptArgs: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...scriptArgs], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), status: e.status ?? 1 };
  }
}

describe("verify-manifest.js", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Clean — manifest and registry agree ─────────────────────────────

  it("exits 0 when manifest and registry agree for all non-empty entries", () => {
    // registry: vault=ID_A, zap=ID_B; all others empty
    const registryPath = writeRegistry(tmpDir, {
      testnet: {
        vault: ID_A,
        zap: ID_B,
        token: "",
        governance: "",
        strategy: "",
        emissionController: "",
        liquidStaking: "",
        stableswap: "",
        vesting: "",
      },
      mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
    });

    // manifest: yield_vault=ID_A (maps to vault), zap=ID_B
    const manifestPath = writeManifest(tmpDir, {
      schemaVersion: "1.0",
      ...validProvenance(),
      network: "testnet",
      commitSha: "abc123",
      branch: "main",
      contracts: {
        yield_vault: ID_A,
        zap: ID_B,
      },
    });

    const result = runScript(
      ["--manifest", manifestPath, "--registry", registryPath, "--network", "testnet"]
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASSED");
  });

  // ── 2. Missing — registry has entry, manifest does not ────────────────

  it("exits 1 and reports MISSING when registry has a non-empty address absent from manifest", () => {
    // registry: vault=ID_A; manifest: only zap (no yield_vault)
    const registryPath = writeRegistry(tmpDir, {
      testnet: { vault: ID_A, zap: ID_B, token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
    });

    const manifestPath = writeManifest(tmpDir, {
      schemaVersion: "1.0",
      ...validProvenance(),
      network: "testnet",
      commitSha: "abc123",
      branch: "main",
      contracts: {
        zap: ID_B,
        // yield_vault intentionally absent
      },
    });

    const result = runScript(
      ["--manifest", manifestPath, "--registry", registryPath, "--network", "testnet"]
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("MISSING");
    expect(result.stdout).toContain("vault");
    expect(result.stdout).toContain("FAILED");
  });

  // ── 3. Stale — manifest has entry, registry is empty for that alias ───

  it("exits 1 and reports STALE when manifest has an entry the registry does not know about", () => {
    // registry: all empty (no vaults deployed in this network's registry yet)
    const registryPath = writeRegistry(tmpDir, {
      testnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
    });

    // manifest: yield_vault=ID_A — but registry has vault="" (stale manifest)
    const manifestPath = writeManifest(tmpDir, {
      schemaVersion: "1.0",
      ...validProvenance(),
      network: "testnet",
      commitSha: "abc123",
      branch: "main",
      contracts: {
        yield_vault: ID_A,
      },
    });

    const result = runScript(
      ["--manifest", manifestPath, "--registry", registryPath, "--network", "testnet"]
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("STALE");
    expect(result.stdout).toContain("yield_vault");
    expect(result.stdout).toContain("FAILED");
  });

  // ── 4. Mismatch — both have the alias but addresses differ ────────────

  it("exits 1 and reports MISMATCH when registry and manifest disagree on an address", () => {
    // registry: zap=ID_A; manifest: zap=ID_C (different)
    const registryPath = writeRegistry(tmpDir, {
      testnet: { vault: "", zap: ID_A, token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
    });

    const manifestPath = writeManifest(tmpDir, {
      schemaVersion: "1.0",
      ...validProvenance(),
      network: "testnet",
      commitSha: "abc123",
      branch: "main",
      contracts: {
        zap: ID_C, // does not match registry's zap (ID_A)
      },
    });

    const result = runScript(
      ["--manifest", manifestPath, "--registry", registryPath, "--network", "testnet"]
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("MISMATCH");
    expect(result.stdout).toContain("zap");
    expect(result.stdout).toContain("FAILED");
  });

  it("exits 1 when provenance metadata is missing", () => {
    const registryPath = writeRegistry(tmpDir, {
      testnet: { vault: ID_A, zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
    });

    const manifestPath = writeManifest(tmpDir, {
      schemaVersion: "1.0",
      generatedAt: "2026-05-28T12:00:00.000Z",
      network: "testnet",
      commitSha: "abc123",
      branch: "main",
      contracts: { yield_vault: ID_A },
    });

    const result = runScript(
      ["--manifest", manifestPath, "--registry", registryPath, "--network", "testnet"]
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("provenance");
    expect(result.stdout).toContain("missing or malformed");
  });

  it("exits 1 when provenance metadata has malformed source hash", () => {
    const registryPath = writeRegistry(tmpDir, {
      testnet: { vault: ID_A, zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
    });
    const base = validProvenance();
    const provenance = {
      ...base.provenance,
      sourceInput: { path: "contracts/scripts/deployed.json", sha256: "not-a-sha" },
    };

    const manifestPath = writeManifest(tmpDir, {
      schemaVersion: "1.0",
      ...base,
      provenance,
      network: "testnet",
      commitSha: "abc123",
      branch: "main",
      contracts: { yield_vault: ID_A },
    });

    const result = runScript(
      ["--manifest", manifestPath, "--registry", registryPath, "--network", "testnet"]
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("sourceInput.sha256");
  });

  // ── 5. Absent manifest file — graceful skip ───────────────────────────

  it("exits 0 with a skip message when the manifest file does not exist", () => {
    const registryPath = writeRegistry(tmpDir, {
      testnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      mainnet: { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
      local:   { vault: "", zap: "", token: "", governance: "", strategy: "", emissionController: "", liquidStaking: "", stableswap: "", vesting: "" },
    });

    const nonExistentManifest = path.join(tmpDir, "does-not-exist.json");

    const result = runScript(
      ["--manifest", nonExistentManifest, "--registry", registryPath, "--network", "testnet"]
    );

    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("skipping");
  });
});
