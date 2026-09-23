/**
 * Vault Migration Readiness Service (#1293)
 *
 * Produces a deterministic, typed migration-readiness checklist for a vault by
 * evaluating each gate from the source-of-truth template at
 * contracts/scripts/migration-readiness-gates.json against real evidence:
 * registry addresses, the yields feed, indexer share-price snapshots, and
 * backend liveness.
 *
 * The checklist is read-only and never mutates state. Error states are typed
 * (VaultMigrationReadinessError) so callers never parse raw provider messages.
 */

import * as fs from "fs";
import * as path from "path";
import { getContractId, type NetworkName } from "./contractRegistry";
import { getYieldDataWithCacheStatus, type YieldCacheStatus } from "./yieldService";

export type MigrationGateStatus = "pass" | "warn" | "fail" | "unknown";
export type MigrationTargetArea = "contract" | "server" | "client" | "devops";

export interface MigrationGateTemplate {
  id: string;
  title: string;
  description: string;
  targetArea: MigrationTargetArea;
  evidenceType: string;
  reference: string;
  guidance: string;
}

export interface ReadinessGateResult extends MigrationGateTemplate {
  status: MigrationGateStatus;
  evidence: string[];
}

export type MigrationOverallStatus = "ready" | "not_ready" | "unknown";

export interface VaultMigrationReadinessReport {
  vaultSlug: string;
  vaultName: string;
  network: string;
  overallStatus: MigrationOverallStatus;
  statusCounts: Record<MigrationGateStatus, number>;
  gates: ReadinessGateResult[];
}

export class VaultMigrationReadinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "VaultMigrationReadinessError";
  }
}

const GATES_PATH = path.resolve(
  __dirname,
  "../../../../contracts/scripts/migration-readiness-gates.json",
);

export const VAULT_REGISTRY: Record<string, { name: string; asset: string; protocol: string }> = {
  usdc:       { name: "USDC Yield Vault",    asset: "USDC",       protocol: "Blend" },
  xlm:        { name: "XLM Yield Vault",     asset: "XLM",        protocol: "Blend" },
  "xlm-usdc": { name: "XLM-USDC LP Vault",  asset: "XLM-USDC",   protocol: "Soroswap" },
  "xlm-eth":  { name: "XLM-ETH LP Vault",   asset: "XLM-ETH",    protocol: "Soroswap" },
  index:      { name: "Yield Index Vault",   asset: "Yield Index", protocol: "DeFindex" },
  bluechip:   { name: "Blue Chip Vault",     asset: "Blue Chip",  protocol: "DeFindex" },
};

function detectNetwork(): NetworkName {
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? "";
  if (passphrase.includes("mainnet") || passphrase.includes("Public Global")) {
    return "mainnet";
  }
  if (passphrase === "" || passphrase.includes("local") || passphrase.includes("standalone")) {
    return "local";
  }
  return "testnet";
}

function loadGateTemplates(): MigrationGateTemplate[] {
  try {
    const raw = fs.readFileSync(GATES_PATH, "utf8");
    const parsed = JSON.parse(raw) as { gates?: unknown };
    if (!Array.isArray(parsed.gates) || parsed.gates.length === 0) {
      throw new Error("gates array is missing or empty");
    }
    return parsed.gates as MigrationGateTemplate[];
  } catch (err) {
    throw new VaultMigrationReadinessError(
      "GATES_TEMPLATE_UNAVAILABLE",
      `Migration readiness gates template could not be loaded: ${
        err instanceof Error ? err.message : String(err)
      }`,
      500,
    );
  }
}

type SharePricePrismaClient = {
  sharePriceSnapshot: {
    count(args: { where: { vaultId: string } }): Promise<number>;
  };
  $disconnect?: () => Promise<void>;
  $queryRaw?: unknown;
};

async function loadSharePriceCount(vaultId: string): Promise<number | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => {
        sharePriceSnapshot: { count(args: { where: { vaultId: string } }): Promise<number> };
      };
    };
    if (!prismaModule.PrismaClient) return null;
    const client = prismaModule.PrismaClient.prototype
      ? new prismaModule.PrismaClient()
      : null;
    if (!client) return null;
    const count = await client.sharePriceSnapshot.count({ where: { vaultId } });
    await (client as unknown as SharePricePrismaClient).$disconnect?.().catch(() => undefined);
    return count;
  } catch {
    return null;
  }
}

interface Evidence {
  registryOk: boolean;
  contractAddress: string;
  yieldsOk: boolean;
  yieldEntryFound: boolean;
  yieldEntryStale: boolean;
  cacheStatus: YieldCacheStatus | null;
  sharesSeen: number | null;
  network: NetworkName;
}

/**
 * Gather deterministic evidence for a vault without depending on raw provider
 * messages. Every failure is downgraded to a boolean so the checklist output is
 * stable.
 */
async function gatherEvidence(vaultId: string): Promise<Evidence> {
  const network = detectNetwork();
  const contractAddress = getContractId("vault", network);

  let yieldsOk = false;
  let yieldEntryFound = false;
  let yieldEntryStale = false;
  let cacheStatus: YieldCacheStatus | null = null;

  try {
    const meta = VAULT_REGISTRY[vaultId];
    const { data, cacheStatus: status } = await getYieldDataWithCacheStatus();
    cacheStatus = status;
    yieldsOk = data.length > 0;
    if (meta) {
      const entry = data.find(
        (d) =>
          d.protocolName.toLowerCase() === meta.protocol.toLowerCase() &&
          d.asset.toLowerCase() === meta.asset.toLowerCase(),
      );
      if (entry) {
        yieldEntryFound = true;
        const ageSeconds = Number.isFinite(new Date(entry.fetchedAt).getTime())
          ? Math.max(0, (Date.now() - new Date(entry.fetchedAt).getTime()) / 1000)
          : Number.POSITIVE_INFINITY;
        yieldEntryStale = ageSeconds > 30 * 60;
      }
    }
  } catch {
    yieldsOk = false;
  }

  const sharesSeen = await loadSharePriceCount(vaultId);

  return {
    registryOk: contractAddress.length > 0,
    contractAddress,
    yieldsOk,
    yieldEntryFound,
    yieldEntryStale,
    cacheStatus,
    sharesSeen,
    network,
  };
}

function evaluateGate(
  gate: MigrationGateTemplate,
  evidence: Evidence,
): ReadinessGateResult {
  const base = { ...gate };
  switch (gate.evidenceType) {
    case "CONTRACT_ADDRESS":
      return evidence.registryOk
        ? { ...base, status: "pass", evidence: [`Registry address present for network "${evidence.network}"`] }
        : {
            ...base,
            status: "fail",
            evidence: [`No vault address registered for network "${evidence.network}"`],
          };
    case "YIELD_STATS": {
      if (!evidence.yieldsOk) {
        return {
          ...base,
          status: "unknown",
          evidence: ["Yields feed did not return data"],
        };
      }
      if (!evidence.yieldEntryFound) {
        return { ...base, status: "fail", evidence: ["No yields entry for this protocol/asset pair"] };
      }
      if (evidence.yieldEntryStale) {
        return { ...base, status: "warn", evidence: ["Yield entry is stale (>30m old)"] };
      }
      return { ...base, status: "pass", evidence: ["Yield entry present and fresh"] };
    }
    case "SHARE_PRICE_HISTORY": {
      if (evidence.sharesSeen === null) {
        return {
          ...base,
          status: "warn",
          evidence: ["Share-price database unavailable — deterministic fixture in use"],
        };
      }
      if (evidence.sharesSeen === 0) {
        return { ...base, status: "warn", evidence: ["No share-price snapshots yet"] };
      }
      return {
        ...base,
        status: "pass",
        evidence: [`${evidence.sharesSeen} share-price snapshot(s) present`],
      };
    }
    case "BACKEND_HEALTH": {
      if (!evidence.yieldsOk) {
        return { ...base, status: "fail", evidence: ["Backend yields feed is not healthy"] };
      }
      return { ...base, status: "pass", evidence: ["Backend yields feed is healthy"] };
    }
    case "DEPOSIT_AVAILABLE": {
      const reasons: string[] = [];
      if (!evidence.registryOk) reasons.push("vault contract not registered");
      if (!evidence.yieldsOk || !evidence.yieldEntryFound) reasons.push("vault stats unavailable");
      if (reasons.length > 0) {
        return { ...base, status: "fail", evidence: [`Deposit path blocked: ${reasons.join(", ")}`] };
      }
      return { ...base, status: "pass", evidence: ["Deposit path available"] };
    }
    case "WITHDRAW_AVAILABLE": {
      const reasons: string[] = [];
      if (evidence.sharesSeen === null && !evidence.registryOk) reasons.push("share-price pricing unavailable");
      if (!evidence.registryOk) reasons.push("vault contract not registered");
      if (evidence.sharesSeen === 0) reasons.push("share-price backfill missing");
      if (reasons.length > 0) {
        return { ...base, status: "warn", evidence: [`Withdraw path gated: ${reasons.join(", ")}`] };
      }
      return { ...base, status: "pass", evidence: ["Withdraw path can price shares"] };
    }
    default:
      return { ...base, status: "unknown", evidence: [`Unsupported evidence type ${gate.evidenceType}`] };
  }
}

/**
 * Derive the overall readiness status from gate results.
 *
 * Policy:
 *   - any gate `fail`            → "not_ready"
 *   - no fails but any `unknown` → "unknown"
 *   - otherwise (pass/warn)      → "ready"
 */
export function deriveMigrationOverallStatus(
  gates: Pick<ReadinessGateResult, "status">[],
): MigrationOverallStatus {
  const hasFail = gates.some((g) => g.status === "fail");
  const hasUnknown = gates.some((g) => g.status === "unknown");
  if (hasFail) return "not_ready";
  if (hasUnknown) return "unknown";
  return "ready";
}

export function countMigrationGateStatuses(
  gates: Pick<ReadinessGateResult, "status">[],
): Record<MigrationGateStatus, number> {
  return {
    pass: gates.filter((g) => g.status === "pass").length,
    warn: gates.filter((g) => g.status === "warn").length,
    fail: gates.filter((g) => g.status === "fail").length,
    unknown: gates.filter((g) => g.status === "unknown").length,
  };
}

/**
 * Build a deterministic migration-readiness checklist for a vault slug.
 */
export async function buildVaultMigrationReadiness(
  slug: string,
): Promise<VaultMigrationReadinessReport> {
  const normalized = String(slug ?? "").trim().toLowerCase();
  const meta = VAULT_REGISTRY[normalized];
  if (!meta) {
    throw new VaultMigrationReadinessError(
      "UNKNOWN_VAULT",
      `Unknown vault slug "${slug}". Valid slugs: ${Object.keys(VAULT_REGISTRY).join(", ")}.`,
    );
  }

  const templates = loadGateTemplates();
  const evidence = await gatherEvidence(normalized);
  const gates = templates.map((gate) => evaluateGate(gate, evidence));

  return {
    vaultSlug: normalized,
    vaultName: meta.name,
    network: evidence.network,
    overallStatus: deriveMigrationOverallStatus(gates),
    statusCounts: countMigrationGateStatuses(gates),
    gates,
  };
}