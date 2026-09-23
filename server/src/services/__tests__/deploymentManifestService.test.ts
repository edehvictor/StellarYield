/**
 * Tests for deployment manifest verification (#1296).
 *
 * Verifies the deterministic, typed status ladder using temp-dir manifests and
 * an injected registry map, so no real deployment artifacts are required.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildDeploymentManifestVerification,
  DeploymentManifestError,
  type DeploymentManifestVerification,
} from "../deploymentManifestService";

const ID_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ID_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";
const ID_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCSC4";
const VALID_SHA = "a".repeat(64);

function provenance(network = "testnet") {
  const generatedAt = "2026-05-28T12:00:00.000Z";
  return {
    generatedAt,
    provenance: {
      generatedBy: "contracts/scripts/generate-manifest.js",
      generatedAt,
      sourceInput: { path: "contracts/scripts/deployed.json", sha256: VALID_SHA },
      registryInput: { path: "contracts/registry.json", sha256: VALID_SHA },
      network: { name: network, rpcUrl: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
      git: { commitSha: "abc123", branch: "main", remoteUrl: "https://github.com/Kappa16/StellarYield.git" },
      ci: { provider: "local", runId: "local", workflow: "local", actor: "test" },
    },
  };
}

function withManifest(
  data: Record<string, unknown>,
): { verification: (opts?: { registry?: Record<string, string>; network?: string }) => DeploymentManifestVerification } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-manifest-test-"));
  const manifestPath = path.join(dir, "deployment-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2));

  const api = {
    verification: (opts: { registry?: Record<string, string>; network?: string } = {}) =>
      buildDeploymentManifestVerification(opts.network as any, {
        manifestPath,
        registry: opts.registry,
      }),
  };

  return api;
}

describe("buildDeploymentManifestVerification", () => {
  it("rejects invalid networks with a typed error", () => {
    try {
      buildDeploymentManifestVerification("invalid" as any, { manifestPath: "/no/such/file" });
      throw new Error("expected DeploymentManifestError");
    } catch (err) {
      expect(err).toBeInstanceOf(DeploymentManifestError);
      expect((err as DeploymentManifestError).code).toBe("INVALID_NETWORK");
      expect((err as DeploymentManifestError).statusCode).toBe(400);
    }
  });

  it("reports pending_generation when the manifest file is absent", () => {
    const ver = buildDeploymentManifestVerification("testnet", {
      manifestPath: "/no/such/deployment-manifest.json",
    });
    expect(ver.status).toBe("pending_generation");
    expect(ver.issues[0].code).toBe("MANIFEST_MALFORMED");
    expect(ver.contracts).toEqual([]);
  });

  it("reports invalid for an unsupported schema version", () => {
    const { verification } = withManifest({
      schemaVersion: "9.9",
      ...provenance(),
      network: "testnet",
      contracts: { yield_vault: ID_A },
    });
    const ver = verification();
    expect(ver.status).toBe("invalid");
    expect(ver.issues.some((i) => i.code === "SCHEMA_VERSION_UNSUPPORTED")).toBe(true);
  });

  it("reports invalid for malformed provenance", () => {
    const { verification } = withManifest({
      schemaVersion: "1.0",
      generatedAt: "2026-05-28T12:00:00.000Z",
      network: "testnet",
      contracts: { yield_vault: ID_A },
    });
    const ver = verification({ registry: { vault: ID_A } });
    expect(ver.status).toBe("invalid");
    expect(ver.issues.some((i) => i.code === "PROVENANCE_INVALID")).toBe(true);
  });

  it("reports drift when manifest and registry disagree and matches the rest", () => {
    const { verification } = withManifest({
      schemaVersion: "1.0",
      ...provenance("testnet"),
      network: "testnet",
      contracts: { yield_vault: ID_A, zap: ID_C },
    });
    const ver = verification({ registry: { vault: ID_A, zap: ID_B } });
    expect(ver.status).toBe("drift");
    expect(ver.contracts.find((c) => c.name === "yield_vault")?.status).toBe("MATCH");
    expect(ver.contracts.find((c) => c.name === "zap")?.status).toBe("MISMATCH");
    expect(ver.issues.filter((i) => i.code === "DRIFT")).toHaveLength(1);
  });

  it("reports verified when manifest, registry, and provenance agree", () => {
    const { verification } = withManifest({
      schemaVersion: "1.0",
      ...provenance("testnet"),
      network: "testnet",
      contracts: { yield_vault: ID_A, zap: ID_B },
    });
    const ver = verification({ registry: { vault: ID_A, zap: ID_B } });
    expect(ver.status).toBe("verified");
    expect(ver.issues).toHaveLength(0);
    expect(ver.contracts.map((c) => c.status)).toEqual(["MATCH", "MATCH"]);
  });
});