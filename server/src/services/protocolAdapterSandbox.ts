import { createHash } from "crypto";
import type {
  AdapterComplianceReport,
  ProtocolAdapterPayload,
} from "./protocolAdapterCompliance";
import { validateProtocolAdapterPayload } from "./protocolAdapterCompliance";

export type ProtocolAdapterMode = "live" | "sandbox";

export interface SandboxAdapterConfig {
  mode: ProtocolAdapterMode;
  fixtureSeed: string;
}

const SANDBOX_ENV = "PROTOCOL_ADAPTER_SANDBOX";
const SANDBOX_SEED_ENV = "PROTOCOL_ADAPTER_SANDBOX_SEED";

export function getProtocolAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): SandboxAdapterConfig {
  const raw = (env[SANDBOX_ENV] ?? "").trim().toLowerCase();
  const enabled = raw === "1" || raw === "true" || raw === "sandbox" || raw === "on";
  return {
    mode: enabled ? "sandbox" : "live",
    fixtureSeed: (env[SANDBOX_SEED_ENV] ?? "stellaryield-local").trim() || "stellaryield-local",
  };
}

function seededNumber(seed: string, min: number, max: number): number {
  const digest = createHash("sha256").update(seed).digest();
  const value = digest.readUInt32BE(0) / 0xffffffff;
  return min + value * (max - min);
}

export function buildSandboxAdapterPayload(
  adapterName: string,
  config: SandboxAdapterConfig = getProtocolAdapterConfig(),
  now: Date = new Date(),
): ProtocolAdapterPayload {
  const fetchedAt = now.toISOString();
  const apy = Number(seededNumber(`${config.fixtureSeed}:${adapterName}:apy`, 2, 14).toFixed(4));
  const tvlUsd = Number(
    seededNumber(`${config.fixtureSeed}:${adapterName}:tvl`, 50_000, 5_000_000).toFixed(2),
  );
  return {
    protocolName: adapterName,
    vaultId: `sandbox-${adapterName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    apy,
    tvlUsd,
    fetchedAt,
  };
}

export async function runProtocolAdapterWithSandbox(
  adapterName: string,
  adapter: () => Promise<unknown>,
  config: SandboxAdapterConfig = getProtocolAdapterConfig(),
): Promise<AdapterComplianceReport & { mode: ProtocolAdapterMode }> {
  if (config.mode === "sandbox") {
    const payload = buildSandboxAdapterPayload(adapterName, config);
    const validation = validateProtocolAdapterPayload(payload);
    return {
      adapterName,
      mode: "sandbox",
      status: validation.valid ? "valid" : "partial",
      checkedAt: new Date().toISOString(),
      errors: validation.errors,
      payload,
    };
  }

  const checkedAt = new Date().toISOString();
  try {
    const raw = await adapter();
    const validation = validateProtocolAdapterPayload(raw);
    return {
      adapterName,
      mode: "live",
      status: validation.valid ? "valid" : validation.stale ? "stale" : "partial",
      checkedAt,
      errors: validation.errors,
      payload: validation.valid ? (raw as ProtocolAdapterPayload) : undefined,
    };
  } catch (err) {
    return {
      adapterName,
      mode: "live",
      status: "providerFailure",
      checkedAt,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
