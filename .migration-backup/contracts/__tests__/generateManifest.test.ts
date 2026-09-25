import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Tests for generate-manifest.js
 *
 * We exercise the core validation and manifest-generation logic by calling
 * the script as a child process (via execSync) with temp fixtures, so we
 * don't need to refactor the CJS script into ESM modules.
 */
import { execSync } from "child_process";
import crypto from "crypto";

const SCRIPT = path.resolve(__dirname, "../scripts/generate-manifest.js");

// A valid 56-char Soroban contract ID (starts with C, base32)
const VALID_ID_1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_ID_2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
}

function writeDeployed(dir: string, data: Record<string, string>): string {
  const p = path.join(dir, "deployed.json");
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runScript(args: string, cwd?: string): { stdout: string; status: number } {
  try {
    const stdout = execSync(`node "${SCRIPT}" ${args}`, {
      encoding: "utf8",
      cwd: cwd ?? process.cwd(),
    });
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? e.stderr ?? "", status: e.status ?? 1 };
  }
}

describe("generate-manifest.js", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a valid manifest JSON for well-formed input", () => {
    const inputPath = writeDeployed(tmpDir, {
      yield_vault: VALID_ID_1,
      zap: VALID_ID_2,
    });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network testnet --output "${outputPath}"`,
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(manifest.schemaVersion).toBe("1.0");
    expect(manifest.network).toBe("testnet");
    expect(manifest.contracts.yield_vault).toBe(VALID_ID_1);
    expect(manifest.contracts.zap).toBe(VALID_ID_2);
    expect(typeof manifest.generatedAt).toBe("string");
    expect(typeof manifest.commitSha).toBe("string");
    expect(manifest.provenance).toMatchObject({
      generatedBy: "contracts/scripts/generate-manifest.js",
      generatedAt: manifest.generatedAt,
      network: { name: "testnet", rpcUrl: "unknown", passphrase: "unknown" },
      git: { commitSha: manifest.commitSha, branch: manifest.branch },
    });
    expect(manifest.provenance.sourceInput.path).toBe(inputPath);
    expect(manifest.provenance.sourceInput.sha256).toBe(sha256File(inputPath));
    expect(manifest.provenance.registryInput.path).toBe("contracts/registry.json");
    expect(manifest.provenance.registryInput.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof manifest.provenance.ci.provider).toBe("string");
  });

  it("rejects an invalid network name", () => {
    const inputPath = writeDeployed(tmpDir, { yield_vault: VALID_ID_1 });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network badnetwork --output "${outputPath}"`,
    );

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("rejects a malformed contract ID", () => {
    const inputPath = writeDeployed(tmpDir, {
      yield_vault: "not-a-valid-id",
    });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network testnet --output "${outputPath}"`,
    );

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("exits with error when input file is missing", () => {
    const result = runScript(
      `--input "/nonexistent/deployed.json" --network testnet --output "${path.join(tmpDir, "m.json")}"`,
    );
    expect(result.status).not.toBe(0);
  });

  it("skips empty-string contract IDs without error", () => {
    const inputPath = writeDeployed(tmpDir, {
      yield_vault: VALID_ID_1,
      zap: "",
    });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network testnet --output "${outputPath}"`,
    );

    expect(result.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(manifest.contracts.yield_vault).toBe(VALID_ID_1);
    expect(manifest.contracts.zap).toBeUndefined();
  });

  it("supports all three allowed networks", () => {
    for (const network of ["testnet", "mainnet", "local"]) {
      const inputPath = writeDeployed(tmpDir, { yield_vault: VALID_ID_1 });
      const outputPath = path.join(tmpDir, `manifest-${network}.json`);

      const result = runScript(
        `--input "${inputPath}" --network ${network} --output "${outputPath}"`,
      );

      expect(result.status).toBe(0);
      const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      expect(manifest.network).toBe(network);
    }
  });

  it("manifest includes generatedAt timestamp in ISO format", () => {
    const inputPath = writeDeployed(tmpDir, { yield_vault: VALID_ID_1 });
    const outputPath = path.join(tmpDir, "manifest.json");

    runScript(`--input "${inputPath}" --network testnet --output "${outputPath}"`);

    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(() => new Date(manifest.generatedAt).toISOString()).not.toThrow();
  });

  it("records explicit network source inputs in provenance", () => {
    const inputPath = writeDeployed(tmpDir, { yield_vault: VALID_ID_1 });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network testnet --rpc-url "https://example-rpc.invalid" --network-passphrase "Test SDF Network ; September 2015" --output "${outputPath}"`,
    );

    expect(result.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(manifest.provenance.network).toEqual({
      name: "testnet",
      rpcUrl: "https://example-rpc.invalid",
      passphrase: "Test SDF Network ; September 2015",
    });
  });

  // ── Alias regression tests (issue #781) ────────────────────────────────────
  // These tests guard against accidental alias renames. If a deployment script
  // starts emitting `yieldVault` instead of `yield_vault`, the manifest will
  // contain the wrong key and downstream consumers silently break.

  it("manifest preserves the exact alias key from deployed.json", () => {
    const inputPath = writeDeployed(tmpDir, { yield_vault: VALID_ID_1, zap: VALID_ID_2 });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network testnet --output "${outputPath}"`,
    );

    expect(result.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    // snake_case aliases must survive intact
    expect(manifest.contracts["yield_vault"]).toBe(VALID_ID_1);
    expect(manifest.contracts["zap"]).toBe(VALID_ID_2);
  });

  it("manifest does NOT contain camelCase alias when deployed.json uses snake_case", () => {
    // Regression: deploy.sh emits `yield_vault`; a renamed alias `yieldVault` must
    // NOT appear in the manifest — consumers would silently get undefined.
    const inputPath = writeDeployed(tmpDir, { yield_vault: VALID_ID_1 });
    const outputPath = path.join(tmpDir, "manifest.json");

    runScript(`--input "${inputPath}" --network testnet --output "${outputPath}"`);

    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(manifest.contracts["yieldVault"]).toBeUndefined();
    expect(manifest.contracts["yield_vault"]).toBe(VALID_ID_1);
  });

  it("manifest built from renamed alias yieldVault is missing expected yield_vault key", () => {
    // This documents the failure mode: if deploy.sh starts emitting camelCase,
    // the manifest will have `yieldVault` but not `yield_vault`, breaking indexers.
    const inputPath = writeDeployed(tmpDir, { yieldVault: VALID_ID_1 });
    const outputPath = path.join(tmpDir, "manifest.json");

    runScript(`--input "${inputPath}" --network testnet --output "${outputPath}"`);

    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(manifest.contracts["yield_vault"]).toBeUndefined();
    expect(manifest.contracts["yieldVault"]).toBe(VALID_ID_1);
  });

  it("manifest includes extra/unexpected aliases without failing", () => {
    // The script does not whitelist alias names; extra keys are included verbatim.
    // This test ensures that adding a new contract to deployed.json doesn't break generation.
    const inputPath = writeDeployed(tmpDir, {
      yield_vault: VALID_ID_1,
      new_contract: VALID_ID_2,
    });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network testnet --output "${outputPath}"`,
    );

    expect(result.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(manifest.contracts["new_contract"]).toBe(VALID_ID_2);
  });

  it("manifest from deployed.json missing required alias omits that key", () => {
    // When a required alias (e.g. `zap`) is simply absent from deployed.json,
    // the manifest must not contain it. Consumers that look up `manifest.contracts.zap`
    // will get undefined — this makes the missing deployment visible at integration time.
    const inputPath = writeDeployed(tmpDir, { yield_vault: VALID_ID_1 });
    const outputPath = path.join(tmpDir, "manifest.json");

    const result = runScript(
      `--input "${inputPath}" --network testnet --output "${outputPath}"`,
    );

    expect(result.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(manifest.contracts["zap"]).toBeUndefined();
  });
});
