/**
 * Vault Migration Readiness Panel (#1293)
 *
 * Renders the deterministic migration readiness checklist for a vault as a
 * gate-by-gate status board. Handles loading, failure, empty (no gates), and
 * success states. Read-only: it never triggers or executes a migration.
 */

import { useEffect, useState } from "react";
import {
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ExternalLink,
} from "lucide-react";
import {
  MigrationReadinessService,
  type MigrationReadinessReport,
} from "../services/migrationReadinessService";
import { deriveOverallStatus, countGateStatuses } from "../lib/vaultMigrationReadiness";
import StatusBadge from "./StatusBadge";

export interface VaultMigrationReadinessPanelProps {
  vaultSlug: string;
  /** When provided, the panel renders this report instead of fetching it. */
  report?: MigrationReadinessReport;
}

const GATE_ICONS = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  unknown: HelpCircle,
} as const;

const GATE_STYLES: Record<string, { border: string; icon: string; text: string }> = {
  pass: { border: "border-green-500/30 bg-green-500/5", icon: "text-green-400", text: "text-green-300" },
  warn: { border: "border-amber-500/30 bg-amber-500/5", icon: "text-amber-400", text: "text-amber-300" },
  fail: { border: "border-red-500/30 bg-red-500/5", icon: "text-red-400", text: "text-red-300" },
  unknown: { border: "border-white/10 bg-black/20", icon: "text-gray-400", text: "text-gray-300" },
};

export default function VaultMigrationReadinessPanel({
  vaultSlug,
  report: reportProp,
}: VaultMigrationReadinessPanelProps) {
  const [report, setReport] = useState<MigrationReadinessReport | null>(
    reportProp ?? null,
  );
  const [loading, setLoading] = useState(!reportProp);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (reportProp) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await MigrationReadinessService.getReadiness(vaultSlug);
        if (!cancelled) setReport(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Unable to load migration readiness.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [vaultSlug, reportProp]);

  if (loading) {
    return (
      <div className="glass-panel p-6 flex items-center justify-center gap-3 py-12">
        <Loader2 size={24} className="text-indigo-400 animate-spin" />
        <span className="text-sm text-gray-400">Checking migration readiness…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel p-6" role="alert">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert size={20} className="text-red-400" />
          <h3 className="text-lg font-semibold text-white">
            Migration Readiness Check Failed
          </h3>
        </div>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="glass-panel p-6" role="status">
        <div className="flex items-center gap-2 mb-2">
          <ShieldQuestion size={20} className="text-gray-400" />
          <h3 className="text-lg font-semibold text-white">
            Migration Readiness
          </h3>
        </div>
        <p className="text-sm text-gray-400">
          No readiness data available for this vault.
        </p>
      </div>
    );
  }

  const overall = report.overallStatus;
  const counts = countGateStatuses(report.gates);

  if (report.gates.length === 0) {
    return (
      <div className="glass-panel p-6" role="status">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck size={20} className="text-gray-400" />
          <h3 className="text-lg font-semibold text-white">
            Migration Readiness
          </h3>
        </div>
        <p className="text-sm text-gray-400">
          No migration readiness gates are configured.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} className="text-indigo-400" />
          <h3 className="text-lg font-semibold text-white">
            Vault Migration Readiness
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            variant={
              overall === "ready"
                ? "success"
                : overall === "not_ready"
                  ? "danger"
                  : "neutral"
            }
            compact
            label={report.network.toUpperCase()}
          />
          <StatusBadge
            variant={
              overall === "ready"
                ? "success"
                : overall === "not_ready"
                  ? "danger"
                  : "warning"
            }
            label={
              overall === "ready"
                ? "Ready"
                : overall === "not_ready"
                  ? "Not Ready"
                  : "Unknown"
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        {(
          [
            ["pass", counts.pass, "text-green-300"],
            ["warn", counts.warn, "text-amber-300"],
            ["fail", counts.fail, "text-red-300"],
            ["unknown", counts.unknown, "text-gray-300"],
          ] as const
        ).map(([status, value, color]) => (
          <div
            key={status}
            className={`rounded-lg border border-white/10 bg-black/20 p-3 ${color}`}
            data-testid={`gate-count-${status}`}
          >
            <div className="text-2xl font-bold">{value}</div>
            <div className="text-xs text-gray-400 capitalize">{status}</div>
          </div>
        ))}
      </div>

      <ul className="space-y-2">
        {report.gates.map((gate) => {
          const styles = GATE_STYLES[gate.status] ?? GATE_STYLES.unknown;
          const Icon = GATE_ICONS[gate.status] ?? HelpCircle;
          return (
            <li
              key={gate.id}
              data-testid={`migration-gate-${gate.id}`}
              data-status={gate.status}
              className={`rounded-lg border p-3 ${styles.border}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon className={`w-4 h-4 ${styles.icon} shrink-0`} />
                    <span className="font-medium text-white">{gate.title}</span>
                    <span className="text-xs text-gray-500">
                      {gate.targetArea}
                    </span>
                  </div>
                  <p className="text-sm text-gray-400">{gate.description}</p>
                  {gate.evidence.length > 0 && (
                    <ul className="text-xs text-gray-300 space-y-0.5">
                      {gate.evidence.map((line, idx) => (
                        <li key={idx}>• {line}</li>
                      ))}
                    </ul>
                  )}
                  <a
                    href={gate.reference}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                  >
                    {gate.reference}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-gray-500">
        Read-only checklist that never executes a migration. Resolve every{" "}
        <span className="text-red-300">fail</span> gate before running the
        migration window.
      </p>
    </div>
  );
}