/**
 * DeploymentManifestVerifier.tsx
 *
 * Verifies the contract deployment manifest against the contract registry via
 * GET /api/contracts/deployment-manifest/verify. Renders the typed, ordered
 * statuses (verified | pending_generation | invalid | drift) plus per-contract
 * MATCH/MISSING/MISMATCH/STALE entries and any typed issues.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle, FileWarning } from "lucide-react";
import { StatusBadge, type StatusVariant } from "./StatusBadge";
import { getApiBaseUrl } from "../lib/api";

type NetworkName = "testnet" | "mainnet" | "local";

type ContractStatus = "MATCH" | "MISSING" | "MISMATCH" | "STALE" | "SKIPPED";
type OverallStatus = "verified" | "pending_generation" | "invalid" | "drift";
type IssueCode =
  | "MANIFEST_MALFORMED"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "PROVENANCE_INVALID"
  | "CONTRACT_ID_INVALID"
  | "DRIFT";

interface ContractEntry {
  name: string;
  manifestAddress: string;
  registryAddress: string;
  status: ContractStatus;
}

interface ManifestIssue {
  code: IssueCode;
  message: string;
}

interface VerificationData {
  network: NetworkName;
  manifestPath: string;
  registrySource: string;
  schemaPath: string;
  status: OverallStatus;
  schemaVersion: string | null;
  issues: ManifestIssue[];
  contracts: ContractEntry[];
}

const NETWORKS: NetworkName[] = ["testnet", "mainnet", "local"];

const OVERALL_BADGE: Record<OverallStatus, { variant: StatusVariant; label: string }> = {
  verified: { variant: "success", label: "Verified" },
  pending_generation: { variant: "neutral", label: "No manifest yet" },
  invalid: { variant: "danger", label: "Invalid" },
  drift: { variant: "warning", label: "Drift detected" },
};

const CONTRACT_BADGE: Record<ContractStatus, { variant: StatusVariant; label: string }> = {
  MATCH: { variant: "success", label: "Match" },
  MISSING: { variant: "danger", label: "Missing" },
  MISMATCH: { variant: "warning", label: "Mismatch" },
  STALE: { variant: "warning", label: "Stale" },
  SKIPPED: { variant: "neutral", label: "Skipped" },
};

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

export default function DeploymentManifestVerifier() {
  const [network, setNetwork] = useState<NetworkName>("testnet");
  const [data, setData] = useState<VerificationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (activeNetwork: NetworkName) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${getApiBase()}/api/contracts/deployment-manifest/verify?network=${activeNetwork}`,
      );
      const json = (await res.json()) as {
        ok: boolean;
        data?: VerificationData;
        error?: { code?: string; message?: string };
      };
      if (!res.ok || !json.ok || !json.data) {
        throw new Error(json.error?.message ?? `Server returned ${res.status}`);
      }
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify deployment manifest.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(network);
  }, [network, load]);

  return (
    <div className="glass-panel rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-indigo-400" />
          <h3 className="font-semibold text-white">Deployment Manifest Verification</h3>
        </div>
        <div className="flex gap-1">
          {NETWORKS.map((net) => (
            <button
              key={net}
              type="button"
              onClick={() => setNetwork(net)}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                network === net
                  ? "bg-indigo-500 text-white"
                  : "bg-white/5 text-gray-300 hover:bg-white/10"
              }`}
            >
              {net}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">Verifying deployment manifest…</span>
        </div>
      ) : !data ? (
        <p className="text-sm text-gray-400 py-4">No verification data available.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <StatusBadge variant={OVERALL_BADGE[data.status].variant} label={OVERALL_BADGE[data.status].label} />
            {data.schemaVersion && (
              <span className="text-xs text-gray-500">
                schema {data.schemaVersion} · {data.registrySource}
              </span>
            )}
          </div>

          {data.status === "pending_generation" && (
            <div className="rounded-xl border border-white/10 bg-white/3 p-3 text-sm text-gray-300">
              {data.issues[0]?.message ?? "No deployment manifest recorded yet."}
            </div>
          )}

          {data.issues.length > 0 && data.status !== "pending_generation" && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={15} className="text-amber-400" />
                <p className="text-sm font-semibold text-amber-300">
                  {data.issues.length} issue{data.issues.length !== 1 ? "s" : ""}
                </p>
              </div>
              <ul className="space-y-1 text-xs text-amber-200/90">
                {data.issues.map((issue, idx) => (
                  <li key={`${issue.code}-${idx}`} className="flex items-start gap-2">
                    <code className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-amber-300">
                      {issue.code}
                    </code>
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.contracts.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {data.contracts.map((entry) => {
                const badge = CONTRACT_BADGE[entry.status];
                return (
                  <div key={entry.name} className="rounded-xl border border-white/10 bg-white/3 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-xs text-gray-400">{entry.name}</span>
                      <StatusBadge variant={badge.variant} label={badge.label} compact />
                    </div>
                    <div className="text-xs text-gray-400 space-y-1">
                      {entry.manifestAddress ? (
                        <div className="break-all">
                          <strong className="text-gray-300">Manifest:</strong> {entry.manifestAddress}
                        </div>
                      ) : (
                        <div>
                          <strong className="text-gray-300">Manifest:</strong>{" "}
                          <span className="text-gray-500">(empty)</span>
                        </div>
                      )}
                      {entry.registryAddress ? (
                        <div className="break-all">
                          <strong className="text-gray-300">Registry:</strong> {entry.registryAddress}
                        </div>
                      ) : (
                        <div>
                          <strong className="text-gray-300">Registry:</strong>{" "}
                          <span className="text-gray-500">(empty)</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {data.status === "verified" && (
            <div className="flex items-center gap-2 text-sm text-green-300">
              <FileWarning size={15} />
              <span>Manifest, provenance, and registry agree for {data.network}.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}