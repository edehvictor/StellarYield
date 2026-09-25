import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { YIELD_VAULT_SPEC_HASH } from "../src/generated/yield_vault";
import { ApiClient } from "../src/api/ApiClient";

const ROOT_DIR = resolve(__dirname, "../../..");
const WASM_PATH = join(
  ROOT_DIR,
  "contracts/target/wasm32-unknown-unknown/release/yield_vault.wasm"
);
const OPENAPI_PATH = join(ROOT_DIR, "server/openapi.yaml");

function checkWasmDrift(): void {
  console.log("--> Checking YieldVault WASM spec drift...");
  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `WASM artifact not found at ${WASM_PATH}. Run cargo build first.`
    );
  }

  const wasmBuffer = readFileSync(WASM_PATH);
  const currentWasmHash = createHash("sha256").update(wasmBuffer).digest("hex");

  if (currentWasmHash !== YIELD_VAULT_SPEC_HASH) {
    throw new Error(
      `CONTRACT SPEC DRIFT DETECTED!\n` +
        `  WASM Sha256:       ${currentWasmHash}\n` +
        `  Generated SDK Pin: ${YIELD_VAULT_SPEC_HASH}\n` +
        `Please run 'npm run build:bindings' in packages/sdk to regenerate bindings.`
    );
  }
  console.log("  [OK] Contract spec hash is up-to-date with WASM artifact.");
}

function checkOpenApiDrift(): void {
  console.log("--> Checking ApiClient OpenAPI route drift...");
  if (!existsSync(OPENAPI_PATH)) {
    throw new Error(`OpenAPI spec not found at ${OPENAPI_PATH}.`);
  }

  const openApiContent = readFileSync(OPENAPI_PATH, "utf-8");
  const extractedPaths: string[] = [];
  const lines = openApiContent.split("\n");
  for (const line of lines) {
    const match = line.match(/^  (\/api\/[a-zA-Z0-9_\-/{}\.]+):/);
    if (match) {
      extractedPaths.push(match[1]);
    }
  }

  const sampleClient = new ApiClient({ baseUrl: "http://localhost:3001" });
  const registeredEndpoints = sampleClient.getRegisteredEndpoints();

  for (const endpoint of registeredEndpoints) {
    // Replace dynamic placeholders in route e.g. /api/users/G.../pnl -> /api/users/{walletAddress}/pnl
    const normalizedPattern = endpoint.pathPattern;
    const pathExists = extractedPaths.some((p) => p === normalizedPattern);
    if (!pathExists) {
      throw new Error(
        `API CLIENT DRIFT DETECTED!\n` +
          `  ApiClient route '${normalizedPattern}' (${endpoint.method}) not found in server/openapi.yaml.\n` +
          `Available OpenAPI endpoints include:\n` +
          extractedPaths.slice(0, 10).map((p) => `    - ${p}`).join("\n") +
          `\n...`
      );
    }
  }

  console.log(`  [OK] All ${registeredEndpoints.length} ApiClient routes match server/openapi.yaml.`);
}

export function verifyDrift(): void {
  checkWasmDrift();
  checkOpenApiDrift();
  console.log("\n✅ All drift checks passed successfully.");
}

if (require.main === module) {
  try {
    verifyDrift();
  } catch (err) {
    console.error("\n❌ Drift Verification Failed:", (err as Error).message);
    process.exit(1);
  }
}
